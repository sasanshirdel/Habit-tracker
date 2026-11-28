import { Injectable } from '@nestjs/common';
import type {
  Habit,
  HabitCategory,
  HabitOccurrenceRecord,
  HabitScheduleVersion,
} from '@habit/shared-types';
import {
  preferredTimeToMinutes,
  resolveScheduleRule,
  type HabitDefinition,
  type HabitScheduleRuleDraft,
} from '@habit/shared-validation';
import { PrismaService } from '../../database/index.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  toDbDate,
  toHabit,
  toHabitCategory,
  toOccurrenceRecord,
  toScheduleVersion,
  versionRuleColumns,
} from './habit-mappers.js';
import { readScheduleContext, recordScheduleChange } from './habit-schedule.service.js';
import { snapshotOf } from './schedule-versioning.js';

/** A new habit, already validated with the shared schemas (habitDefinitionSchema and friends). */
export interface NewHabit {
  /**
   * Type, unit and rules. An interval schedule may leave out `anchorDate`: it then defaults to
   * `startsOn`, the first version's start (ADR-0030).
   */
  definition: Omit<HabitDefinition, 'schedule'> & { schedule: HabitScheduleRuleDraft };
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  categoryId: string | null;
  /** First local date; the first schedule version takes effect on it. */
  startsOn: string;
  endsOn: string | null;
  /** Local `HH:MM` or null. */
  preferredTime: string | null;
  position: number;
}

export interface HabitWithSchedule {
  habit: Habit;
  /** All versions, oldest first. */
  scheduleVersions: HabitScheduleVersion[];
}

/** The category does not exist for this user (another user's id looks exactly like a missing one). */
export class HabitCategoryNotFoundError extends Error {
  constructor() {
    super('Habit category not found');
    this.name = 'HabitCategoryNotFoundError';
  }
}

const FOREIGN_KEY_VIOLATION = 'P2003';

/**
 * Data access for the habit tables (backlog P3-01, ADR-0028). Every method takes the owner's
 * `userId` and filters by it, so a caller can never read or attach another user's rows; ids of
 * other users' rows behave like missing ones (callers answer 404, ADR-0019). Soft-deleted habits
 * are invisible here except to the data export. HTTP routes arrive with P3-06; schedule changes
 * are `HabitScheduleService` (P3-03); check-ins (P3-04) add their writes here.
 */
@Injectable()
export class HabitRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a habit and its first schedule version (effective from `startsOn`, open-ended) in one
   * transaction, so a habit never exists without rules — and its type is pinned by the version's
   * foreign key from the first moment. The version snapshots the user's week start and calendar,
   * and the audit trail gets its `create` entry (P3-03, ADR-0030).
   */
  async createHabit(
    userId: string,
    input: NewHabit,
    options: { now?: Date } = {},
  ): Promise<HabitWithSchedule> {
    const definition = {
      ...input.definition,
      schedule: resolveScheduleRule(input.definition.schedule, input.startsOn),
    };
    const now = options.now ?? new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The first version snapshots the user's week start and calendar (ADR-0030).
        const context = await readScheduleContext(tx, userId, now);
        const habit = await tx.habit.create({
          data: {
            userId,
            categoryId: input.categoryId,
            type: definition.type,
            name: input.name,
            description: input.description,
            unit: definition.unit,
            icon: input.icon,
            color: input.color,
            startsOn: toDbDate(input.startsOn),
            endsOn: input.endsOn === null ? null : toDbDate(input.endsOn),
            preferredTimeMinutes:
              input.preferredTime === null ? null : preferredTimeToMinutes(input.preferredTime),
            position: input.position,
          },
        });
        const version = await tx.habitScheduleVersion.create({
          data: {
            userId,
            habitId: habit.id,
            habitType: habit.type,
            effectiveFrom: habit.startsOn,
            ...versionRuleColumns(definition, context),
          },
        });
        const first = toScheduleVersion(version);
        await recordScheduleChange(tx, {
          userId,
          habitId: habit.id,
          versionId: first.id,
          operation: 'create',
          effectiveFrom: first.effectiveFrom,
          localToday: context.today,
          isCorrection: false,
          reason: null,
          affectedRecordedDays: 0,
          before: null,
          after: [snapshotOf(first)],
        });
        return { habit: toHabit(habit), scheduleVersions: [first] };
      });
    } catch (error) {
      if (
        input.categoryId !== null &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === FOREIGN_KEY_VIOLATION
      ) {
        throw new HabitCategoryNotFoundError();
      }
      throw error;
    }
  }

  /** One of the user's habits (archived included, deleted excluded), or null. */
  async findHabit(userId: string, habitId: string): Promise<HabitWithSchedule | null> {
    const row = await this.prisma.habit.findFirst({
      where: { id: habitId, userId, deletedAt: null },
      include: { scheduleVersions: { orderBy: { effectiveFrom: 'asc' } } },
    });
    if (!row) return null;
    const { scheduleVersions, ...habit } = row;
    return { habit: toHabit(habit), scheduleVersions: scheduleVersions.map(toScheduleVersion) };
  }

  /** The user's active habits (not archived, not deleted) in display order. */
  async listActiveHabits(userId: string): Promise<Habit[]> {
    const rows = await this.prisma.habit.findMany({
      where: { userId, archivedAt: null, deletedAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toHabit);
  }

  /** The user's categories in display order. */
  async listCategories(userId: string): Promise<HabitCategory[]> {
    const rows = await this.prisma.habitCategory.findMany({
      where: { userId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toHabitCategory);
  }

  /**
   * Recorded occurrences of the user's (not deleted) habits for local dates `from`..`to`
   * (inclusive), optionally of one habit — the weekly matrix reads one week this way (P3-07).
   */
  async listOccurrences(
    userId: string,
    range: { from: string; to: string; habitId?: string },
  ): Promise<HabitOccurrenceRecord[]> {
    const rows = await this.prisma.habitOccurrence.findMany({
      where: {
        userId,
        ...(range.habitId ? { habitId: range.habitId } : {}),
        localDate: { gte: toDbDate(range.from), lte: toDbDate(range.to) },
        habit: { deletedAt: null },
      },
      orderBy: [{ localDate: 'asc' }, { habitId: 'asc' }],
    });
    return rows.map(toOccurrenceRecord);
  }
}
