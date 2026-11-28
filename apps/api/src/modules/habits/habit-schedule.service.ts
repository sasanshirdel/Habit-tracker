import { Injectable, Logger } from '@nestjs/common';
import { localDateAt } from '@habit/habit-engine';
import type {
  Habit,
  HabitScheduleChange,
  HabitScheduleOperation,
  HabitScheduleVersion,
  HabitScheduleVersionSnapshot,
} from '@habit/shared-types';
import type { HabitScheduleChangeRequest } from '@habit/shared-validation';
import { PrismaService, type DatabaseTransaction } from '../../database/index.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  fromDbDate,
  toDbDate,
  toHabit,
  toScheduleChange,
  toScheduleVersion,
  versionRuleColumns,
} from './habit-mappers.js';
import {
  assertPlanResult,
  HabitScheduleChangeError,
  planScheduleChange,
  snapshotOf,
  versionsAfter,
  type ScheduleSettings,
} from './schedule-versioning.js';

/** The habit does not exist for this user (deleted, another user's, or never existed). */
export class HabitNotFoundError extends Error {
  constructor() {
    super('Habit not found');
    this.name = 'HabitNotFoundError';
  }
}

/** What a schedule change did, and the habit's versions afterwards (oldest first). */
export interface HabitScheduleChangeResult {
  outcome: 'unchanged' | 'split' | 'replace';
  habit: Habit;
  scheduleVersions: HabitScheduleVersion[];
  /** The audit entry written, or `null` when nothing changed. */
  change: HabitScheduleChange | null;
}

/** The user's clock and calendar settings, read in the writing transaction. */
export interface ScheduleContext extends ScheduleSettings {
  timeZone: string;
  /** The user's local date at `now` in `timeZone`. */
  today: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = 'P2002';

/**
 * The user's time zone, week start and calendar, and their "today". Every account gets a
 * preferences row at registration (P2-01); for a row-less account (only possible in tests or
 * damaged data) the user_preferences column defaults apply — UTC, Gregorian, Monday — the same
 * values the P3-03 migration backfilled for such accounts.
 */
export async function readScheduleContext(
  tx: DatabaseTransaction,
  userId: string,
  now: Date,
): Promise<ScheduleContext> {
  const prefs = await tx.userPreference.findUnique({
    where: { userId },
    select: { timezone: true, weekStart: true, calendar: true },
  });
  const timeZone = prefs?.timezone ?? 'UTC';
  return {
    timeZone,
    today: localDateAt(now, timeZone),
    weekStart: prefs?.weekStart ?? 'monday',
    calendar: prefs?.calendar ?? 'gregorian',
  };
}

/** Appends one entry to the schedule audit trail (same transaction as the change). */
export async function recordScheduleChange(
  tx: DatabaseTransaction,
  entry: {
    userId: string;
    habitId: string;
    versionId: string;
    operation: HabitScheduleOperation;
    effectiveFrom: string;
    localToday: string;
    isCorrection: boolean;
    reason: string | null;
    affectedRecordedDays: number;
    before: HabitScheduleVersionSnapshot[] | null;
    after: HabitScheduleVersionSnapshot[];
  },
): Promise<HabitScheduleChange> {
  const row = await tx.habitScheduleChange.create({
    data: {
      userId: entry.userId,
      habitId: entry.habitId,
      versionId: entry.versionId,
      operation: entry.operation,
      effectiveFrom: toDbDate(entry.effectiveFrom),
      localToday: toDbDate(entry.localToday),
      isCorrection: entry.isCorrection,
      reason: entry.reason,
      affectedRecordedDays: entry.affectedRecordedDays,
      before:
        entry.before === null ? Prisma.DbNull : (entry.before as unknown as Prisma.InputJsonValue),
      after: entry.after as unknown as Prisma.InputJsonValue,
    },
  });
  return toScheduleChange(row);
}

function isConcurrencyViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
    return true;
  }
  // The EXCLUDE constraint (SQLSTATE 23P01) has no Prisma code of its own; match its name.
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const e = current as { message?: unknown; code?: unknown; cause?: unknown; meta?: unknown };
    const text = `${String(e.message ?? '')} ${String(e.code ?? '')} ${JSON.stringify(e.meta ?? {})}`;
    if (text.includes('habit_schedule_versions_no_overlap') || text.includes('23P01')) return true;
    current = e.cause;
  }
  return false;
}

/**
 * Schedule versioning (backlog P3-03, ADR-0030): changing a habit's schedule or target closes the
 * version in effect and opens a new one from a chosen local date — or rewrites a version that
 * starts on that date — in one transaction, with an append-only audit entry. The decision rules
 * are the pure `planScheduleChange`; this service adds the transaction, the row lock that
 * serialises concurrent changes of one habit, the optimistic `habits.version` check, the "today"
 * of the user's profile time zone and the integrity checks. Internal API: P3-06 exposes it over
 * HTTP.
 */
@Injectable()
export class HabitScheduleService {
  private readonly logger = new Logger('HabitSchedule');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Applies `request` (already parsed with `habitScheduleChangeSchema`) to one of the user's
   * habits. Throws `HabitNotFoundError` or `HabitScheduleChangeError`.
   */
  async changeSchedule(
    userId: string,
    habitId: string,
    request: HabitScheduleChangeRequest,
    options: { now?: Date } = {},
  ): Promise<HabitScheduleChangeResult> {
    if (!UUID.test(habitId) || !UUID.test(userId)) throw new HabitNotFoundError();
    const now = options.now ?? new Date();
    try {
      const result = await this.prisma.$transaction((tx) =>
        this.changeInTransaction(tx, userId, habitId, request, now),
      );
      if (result.change?.isCorrection) {
        // Corrections re-judge past days: log them (ids and counts only, no free text).
        this.logger.log({
          msg: 'habit schedule correction',
          userId,
          habitId,
          versionId: result.change.versionId,
          operation: result.change.operation,
          effectiveFrom: result.change.effectiveFrom,
          localToday: result.change.localToday,
          affectedRecordedDays: result.change.affectedRecordedDays,
        });
      }
      return result;
    } catch (error) {
      if (isConcurrencyViolation(error)) {
        throw new HabitScheduleChangeError(
          'VERSION_CONFLICT',
          'The schedule was changed concurrently; read it again',
        );
      }
      throw error;
    }
  }

  private async changeInTransaction(
    tx: DatabaseTransaction,
    userId: string,
    habitId: string,
    request: HabitScheduleChangeRequest,
    now: Date,
  ): Promise<HabitScheduleChangeResult> {
    // Row lock: concurrent changes of the same habit run one after the other, and each one plans
    // against the versions the previous one committed (READ COMMITTED re-reads after the lock).
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM habits
      WHERE id = ${habitId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
      FOR UPDATE`;
    if (locked.length === 0) throw new HabitNotFoundError();

    const habitRow = await tx.habit.findUniqueOrThrow({ where: { id: habitId } });
    if (
      request.expectedHabitVersion !== undefined &&
      request.expectedHabitVersion !== habitRow.version
    ) {
      throw new HabitScheduleChangeError('VERSION_CONFLICT', 'The habit changed since it was read');
    }
    const context = await readScheduleContext(tx, userId, now);
    const versionRows = await tx.habitScheduleVersion.findMany({
      where: { habitId },
      orderBy: { effectiveFrom: 'asc' },
    });
    const versions = versionRows.map(toScheduleVersion);
    const habit = {
      type: habitRow.type,
      startsOn: fromDbDate(habitRow.startsOn),
      endsOn: habitRow.endsOn === null ? null : fromDbDate(habitRow.endsOn),
    };

    const plan = planScheduleChange({
      habit,
      versions,
      today: context.today,
      settings: { weekStart: context.weekStart, calendar: context.calendar },
      request,
    });
    if (plan.operation === 'unchanged') {
      return {
        outcome: 'unchanged',
        habit: toHabit(habitRow),
        scheduleVersions: versions,
        change: null,
      };
    }

    const PLANNED_ID = '00000000-0000-7000-8000-000000000000';
    const changedIdPlanned = plan.operation === 'split' ? PLANNED_ID : plan.previous.id;
    assertPlanResult(
      habit,
      plan,
      versionsAfter(versions, plan, PLANNED_ID, now.toISOString()),
      changedIdPlanned,
    );

    const orphansBefore = await this.countOrphanedRecords(tx, habitId);
    const columns = versionRuleColumns(plan.rules, plan.rules);
    let changedId: string;
    if (plan.operation === 'replace') {
      await tx.habitScheduleVersion.update({ where: { id: plan.previous.id }, data: columns });
      changedId = plan.previous.id;
    } else {
      // Close first: the EXCLUDE constraint is checked per statement.
      await tx.habitScheduleVersion.update({
        where: { id: plan.previous.id },
        data: { effectiveTo: toDbDate(plan.effectiveFrom) },
      });
      const created = await tx.habitScheduleVersion.create({
        data: {
          userId,
          habitId,
          habitType: habitRow.type,
          effectiveFrom: toDbDate(plan.effectiveFrom),
          effectiveTo: plan.effectiveTo === null ? null : toDbDate(plan.effectiveTo),
          ...columns,
        },
      });
      changedId = created.id;
    }
    if ((await this.countOrphanedRecords(tx, habitId)) > orphansBefore) {
      throw new HabitScheduleChangeError(
        'ORPHANED_RECORDS',
        'The change would leave recorded days without a schedule version',
      );
    }

    const affectedRecordedDays =
      plan.rejudgedUntil === null
        ? 0
        : await tx.habitOccurrence.count({
            where: {
              habitId,
              localDate: { gte: toDbDate(plan.effectiveFrom), lt: toDbDate(plan.rejudgedUntil) },
            },
          });

    const afterRows = await tx.habitScheduleVersion.findMany({
      where: { habitId },
      orderBy: { effectiveFrom: 'asc' },
    });
    const after = afterRows.map(toScheduleVersion);
    const touched = new Set([plan.previous.id, changedId]);
    const change = await recordScheduleChange(tx, {
      userId,
      habitId,
      versionId: changedId,
      operation: plan.operation,
      effectiveFrom: plan.effectiveFrom,
      localToday: context.today,
      isCorrection: plan.isCorrection,
      reason: plan.reason,
      affectedRecordedDays,
      before: [snapshotOf(plan.previous)],
      after: after.filter((v) => touched.has(v.id)).map(snapshotOf),
    });
    const updatedHabit = await tx.habit.update({
      where: { id: habitId },
      data: { version: { increment: 1 } },
    });
    return {
      outcome: plan.operation,
      habit: toHabit(updatedHabit),
      scheduleVersions: after,
      change,
    };
  }

  /** Recorded days of the habit on dates no version covers (should always be 0). */
  private async countOrphanedRecords(tx: DatabaseTransaction, habitId: string): Promise<number> {
    const [row] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM habit_occurrences o
      WHERE o.habit_id = ${habitId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM habit_schedule_versions v
          WHERE v.habit_id = o.habit_id
            AND v.effective_from <= o.local_date
            AND (v.effective_to IS NULL OR v.effective_to > o.local_date)
        )`;
    return Number(row?.count ?? 0);
  }

  /** The habit's audit trail, oldest first (owner-scoped; deleted habits → not found). */
  async listChanges(userId: string, habitId: string): Promise<HabitScheduleChange[]> {
    if (!UUID.test(habitId) || !UUID.test(userId)) throw new HabitNotFoundError();
    const habit = await this.prisma.habit.findFirst({
      where: { id: habitId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!habit) throw new HabitNotFoundError();
    const rows = await this.prisma.habitScheduleChange.findMany({
      where: { habitId, userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toScheduleChange);
  }
}
