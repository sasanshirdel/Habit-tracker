import { Injectable, Logger } from '@nestjs/common';
import {
  HABIT_DELETED_RESTORE_DAYS,
  type HabitDetail,
  type HabitOrder,
  type HabitScheduleChangeOutcome,
  type HabitScheduleVersion,
  type Paginated,
} from '@habit/shared-types';
import {
  preferredTimeToMinutes,
  unitAllowedFor,
  type HabitCreateRequest,
  type HabitListQuery,
  type HabitScheduleChangeRequest,
  type HabitUpdateRequest,
} from '@habit/shared-validation';
import { z } from 'zod';
import { decodeCursor, paginate } from '../../common/pagination/pagination.js';
import { PrismaService, type DatabaseTransaction } from '../../database/index.js';
import {
  Prisma,
  type Habit as HabitRow,
  type HabitScheduleVersion as HabitScheduleVersionRow,
} from '../../generated/prisma/client.js';
import { fromDbDate, toDbDate, toHabit, toScheduleVersion } from './habit-mappers.js';
import { lockHabitList, lockHabitRow, nextHabitPosition } from './habit-locks.js';
import { HabitCategoryNotFoundError, HabitRepository } from './habit.repository.js';
import {
  HabitNotFoundError,
  HabitScheduleService,
  readScheduleContext,
} from './habit-schedule.service.js';

/** Why a habits-API write was refused (ADR-0032); the HTTP layer maps each to an error code. */
export type HabitWriteErrorCode =
  /** `expectedVersion` is not the stored version (and the request would change something). */
  | 'VERSION_CONFLICT'
  /** A reorder does not list exactly the current members of the list. */
  | 'ORDER_MISMATCH'
  /** The new start/end dates would leave recorded days or schedule versions outside them. */
  | 'HABIT_DATES_CONFLICT'
  /** A category still holds habits (active or archived). */
  | 'CATEGORY_NOT_EMPTY'
  /** Another category of the user already has this name (case-insensitively). */
  | 'CATEGORY_NAME_TAKEN'
  /** Input that only the stored state can reject (field-level, see `details.issues`). */
  | 'INVALID_INPUT';

export class HabitWriteError extends Error {
  override readonly name = 'HabitWriteError';

  constructor(
    readonly code: HabitWriteErrorCode,
    message: string,
    /** Safe, structured details (ids, counts, field paths — never user text). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOREIGN_KEY_VIOLATION = 'P2003';
const DAY_MS = 86_400_000;
export const HABIT_DELETED_RESTORE_MS = HABIT_DELETED_RESTORE_DAYS * DAY_MS;

/** Keyset cursor of the habit list: the last row's position and id. */
const habitCursorSchema = z.strictObject({ position: z.int().min(0), id: z.uuid() });

type HabitRowWithVersions = HabitRow & { scheduleVersions: HabitScheduleVersionRow[] };

/** Field-level refusal in the shape of `VALIDATION_FAILED` details (ADR-0009). */
function invalidInput(field: string, message: string): HabitWriteError {
  return new HabitWriteError('INVALID_INPUT', message, {
    issues: [{ field: `body.${field}`, code: 'custom', message }],
  });
}

function versionConflict(currentVersion: number): HabitWriteError {
  return new HabitWriteError('VERSION_CONFLICT', 'The habit changed since it was read', {
    currentVersion,
  });
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === FOREIGN_KEY_VIOLATION
  );
}

/**
 * The version in effect on `today`; before the first version its first one, after the last one
 * ends the last one; `null` without versions. Versions are ordered and contiguous (ADR-0030).
 */
export function currentVersionIdOn(
  versions: readonly Pick<HabitScheduleVersion, 'id' | 'effectiveFrom' | 'effectiveTo'>[],
  today: string,
): string | null {
  const first = versions[0];
  if (!first) return null;
  if (today < first.effectiveFrom) return first.id;
  const current = versions.find(
    (v) => v.effectiveFrom <= today && (v.effectiveTo === null || today < v.effectiveTo),
  );
  return (current ?? versions[versions.length - 1]!).id;
}

function detailOf(row: HabitRowWithVersions, today: string): HabitDetail {
  const { scheduleVersions, ...habit } = row;
  const versions = scheduleVersions.map(toScheduleVersion);
  return {
    habit: toHabit(habit),
    scheduleVersions: versions,
    currentVersionId: currentVersionIdOn(versions, today),
  };
}

const VERSIONS_ASC = { scheduleVersions: { orderBy: { effectiveFrom: 'asc' as const } } };

/**
 * The habits API (backlog P3-06, ADR-0032): create (all six types, with the first schedule
 * version through `HabitRepository.createHabit`), list, read, edit metadata, change start/end
 * dates, archive / restore, soft delete / undelete within {@link HABIT_DELETED_RESTORE_DAYS}
 * days, reorder, and schedule changes through the P3-03 versioning service. Every query is
 * owner-scoped; another user's habit is indistinguishable from a missing one. Locking follows
 * `habit-locks.ts` (list lock, then row lock). Optimistic concurrency: an optional
 * `expectedVersion` (the habit `version` the client saw) refuses a write after a concurrent one
 * with `VERSION_CONFLICT` — except a write that would change nothing, which is answered with the
 * current state and never conflicts. Every change bumps `version`; reorders do not (the order is a
 * property of the list, not of one habit).
 */
@Injectable()
export class HabitService {
  private readonly logger = new Logger('Habits');

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: HabitRepository,
    private readonly schedules: HabitScheduleService,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────────────────────────

  /** A page of the user's habits of one status (default active), in the user's order. */
  async list(
    userId: string,
    query: HabitListQuery,
    options: { now?: Date } = {},
  ): Promise<Paginated<HabitDetail>> {
    const now = options.now ?? new Date();
    const after =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor, habitCursorSchema);
    return this.prisma.$transaction(async (tx) => {
      const { today } = await readScheduleContext(tx, userId, now);
      const statusWhere: Prisma.HabitWhereInput =
        query.status === 'active'
          ? { archivedAt: null, deletedAt: null }
          : query.status === 'archived'
            ? { archivedAt: { not: null }, deletedAt: null }
            : { deletedAt: { gte: new Date(now.getTime() - HABIT_DELETED_RESTORE_MS) } };
      const categoryWhere: Prisma.HabitWhereInput =
        query.categoryId === undefined
          ? {}
          : { categoryId: query.categoryId === 'none' ? null : query.categoryId.toLowerCase() };
      const rows = await tx.habit.findMany({
        where: {
          userId,
          ...statusWhere,
          ...categoryWhere,
          ...(after
            ? {
                OR: [
                  { position: { gt: after.position } },
                  { position: after.position, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        include: VERSIONS_ASC,
      });
      return paginate(
        rows.map((row) => detailOf(row, today)),
        query.limit,
        (last) => ({ position: last.habit.position, id: last.habit.id }),
      );
    });
  }

  /** One of the user's habits (archived included, deleted not). */
  async get(userId: string, habitId: string, options: { now?: Date } = {}): Promise<HabitDetail> {
    if (!UUID.test(habitId)) throw new HabitNotFoundError();
    const now = options.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.habit.findFirst({
        where: { id: habitId, userId, deletedAt: null },
        include: VERSIONS_ASC,
      });
      if (!row) throw new HabitNotFoundError();
      const { today } = await readScheduleContext(tx, userId, now);
      return detailOf(row, today);
    });
  }

  // ── Creating ──────────────────────────────────────────────────────────────────────────────────

  /** Creates a habit at the end of the user's list, with its first schedule version. */
  async create(
    userId: string,
    request: HabitCreateRequest,
    options: { now?: Date } = {},
  ): Promise<HabitDetail> {
    const now = options.now ?? new Date();
    const created = await this.repository.createHabit(
      userId,
      {
        definition: {
          type: request.type,
          unit: request.unit,
          schedule: request.schedule,
          target: request.target,
          graceDays: request.graceDays,
        },
        name: request.name,
        description: request.description,
        icon: request.icon,
        color: request.color,
        categoryId: request.categoryId === null ? null : request.categoryId.toLowerCase(),
        ...(request.startsOn === undefined ? {} : { startsOn: request.startsOn }),
        endsOn: request.endsOn,
        preferredTime: request.preferredTime,
      },
      { now },
    );
    return this.get(userId, created.habit.id, { now });
  }

  // ── Editing ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Edits metadata and the start/end dates. A start moved earlier extends the first schedule
   * version back; a start moved later or an end moved earlier is refused when recorded days (or,
   * for the start, a later schedule version) would fall outside the habit's dates.
   */
  async update(
    userId: string,
    habitId: string,
    request: HabitUpdateRequest,
    options: { now?: Date } = {},
  ): Promise<HabitDetail> {
    if (!UUID.test(habitId)) throw new HabitNotFoundError();
    const now = options.now ?? new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const row = await lockHabitRow(tx, userId, habitId);
        if (!row) throw new HabitNotFoundError();
        const data = this.changedFields(row, request);
        if (Object.keys(data).length === 0) return; // no-op: never a conflict
        if (request.expectedVersion !== undefined && request.expectedVersion !== row.version) {
          throw versionConflict(row.version);
        }
        if (data.unit !== undefined) this.assertUnit(row, data.unit);
        const oldStart = fromDbDate(row.startsOn);
        const newStart = request.startsOn ?? oldStart;
        const oldEnd = row.endsOn === null ? null : fromDbDate(row.endsOn);
        const newEnd = request.endsOn === undefined ? oldEnd : request.endsOn;
        if (newEnd !== null && newEnd < newStart) {
          throw invalidInput(
            request.endsOn === undefined ? 'startsOn' : 'endsOn',
            'A habit must not end before it starts',
          );
        }
        if (newStart !== oldStart) await this.moveStart(tx, row, oldStart, newStart);
        if (newEnd !== oldEnd && newEnd !== null) await this.assertNoRecordsAfter(tx, row, newEnd);
        await tx.habit.update({
          where: { id: habitId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.description !== undefined ? { description: data.description } : {}),
            ...(data.unit !== undefined ? { unit: data.unit } : {}),
            ...(data.icon !== undefined ? { icon: data.icon } : {}),
            ...(data.color !== undefined ? { color: data.color } : {}),
            ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
            ...(data.preferredTimeMinutes !== undefined
              ? { preferredTimeMinutes: data.preferredTimeMinutes }
              : {}),
            ...(data.startsOn !== undefined ? { startsOn: toDbDate(data.startsOn) } : {}),
            ...(data.endsOn !== undefined
              ? { endsOn: data.endsOn === null ? null : toDbDate(data.endsOn) }
              : {}),
            version: { increment: 1 },
          },
        });
        if (data.startsOn !== undefined || data.endsOn !== undefined) {
          // Dates decide which days are tracked: logged like schedule corrections (no free text).
          this.logger.log({
            msg: 'habit dates changed',
            userId,
            habitId,
            startsOn: newStart,
            endsOn: newEnd,
          });
        }
      });
    } catch (error) {
      if (request.categoryId && isForeignKeyViolation(error)) {
        throw new HabitCategoryNotFoundError();
      }
      throw error;
    }
    return this.get(userId, habitId, { now });
  }

  /** The fields of `request` that differ from the stored row (normalised as stored). */
  private changedFields(row: HabitRow, request: HabitUpdateRequest) {
    const changed: {
      name?: string;
      description?: string | null;
      unit?: string | null;
      icon?: string | null;
      color?: string | null;
      categoryId?: string | null;
      preferredTimeMinutes?: number | null;
      startsOn?: string;
      endsOn?: string | null;
    } = {};
    if (request.name !== undefined && request.name !== row.name) changed.name = request.name;
    if (request.description !== undefined && request.description !== row.description) {
      changed.description = request.description;
    }
    if (request.unit !== undefined && request.unit !== row.unit) changed.unit = request.unit;
    if (request.icon !== undefined && request.icon !== row.icon) changed.icon = request.icon;
    if (request.color !== undefined && request.color !== row.color) changed.color = request.color;
    if (request.categoryId !== undefined) {
      const categoryId = request.categoryId === null ? null : request.categoryId.toLowerCase();
      if (categoryId !== row.categoryId) changed.categoryId = categoryId;
    }
    if (request.preferredTime !== undefined) {
      const minutes =
        request.preferredTime === null ? null : preferredTimeToMinutes(request.preferredTime);
      if (minutes !== row.preferredTimeMinutes) changed.preferredTimeMinutes = minutes;
    }
    if (request.startsOn !== undefined && request.startsOn !== fromDbDate(row.startsOn)) {
      changed.startsOn = request.startsOn;
    }
    if (request.endsOn !== undefined) {
      const stored = row.endsOn === null ? null : fromDbDate(row.endsOn);
      if (request.endsOn !== stored) changed.endsOn = request.endsOn;
    }
    return changed;
  }

  private assertUnit(row: HabitRow, unit: string | null): void {
    const allowed = unitAllowedFor(row.type);
    if (allowed === 'required' && unit === null) {
      throw invalidInput('unit', 'Custom habits need a unit');
    }
    if (allowed === 'none' && unit !== null) {
      throw invalidInput('unit', 'This habit type has no unit');
    }
  }

  /** Moves the habit's first day: the first schedule version starts on the new day. */
  private async moveStart(
    tx: DatabaseTransaction,
    row: HabitRow,
    oldStart: string,
    newStart: string,
  ): Promise<void> {
    const versions = await tx.habitScheduleVersion.findMany({
      where: { habitId: row.id },
      orderBy: { effectiveFrom: 'asc' },
    });
    const first = versions[0];
    if (!first) throw new HabitNotFoundError();
    if (newStart > oldStart) {
      if (first.effectiveTo !== null && newStart >= fromDbDate(first.effectiveTo)) {
        throw new HabitWriteError(
          'HABIT_DATES_CONFLICT',
          'A later schedule version starts on or before the new first day',
          { reason: 'schedule_versions' },
        );
      }
      const before = await tx.habitOccurrence.count({
        where: { habitId: row.id, localDate: { lt: toDbDate(newStart) } },
      });
      if (before > 0) {
        throw new HabitWriteError(
          'HABIT_DATES_CONFLICT',
          'Recorded days would fall before the new first day',
          { reason: 'records_outside_dates', recordedDays: before },
        );
      }
    }
    await tx.habitScheduleVersion.update({
      where: { id: first.id },
      data: { effectiveFrom: toDbDate(newStart) },
    });
  }

  private async assertNoRecordsAfter(
    tx: DatabaseTransaction,
    row: HabitRow,
    newEnd: string,
  ): Promise<void> {
    const after = await tx.habitOccurrence.count({
      where: { habitId: row.id, localDate: { gt: toDbDate(newEnd) } },
    });
    if (after > 0) {
      throw new HabitWriteError(
        'HABIT_DATES_CONFLICT',
        'Recorded days would fall after the new last day',
        { reason: 'records_outside_dates', recordedDays: after },
      );
    }
  }

  /** Changes schedule, target or grace days through the P3-03 versioning rules (ADR-0030). */
  async changeSchedule(
    userId: string,
    habitId: string,
    request: HabitScheduleChangeRequest,
    options: { now?: Date } = {},
  ): Promise<HabitScheduleChangeOutcome> {
    const now = options.now ?? new Date();
    const result = await this.schedules.changeSchedule(userId, habitId, request, { now });
    return {
      outcome: result.outcome,
      detail: await this.get(userId, habitId, { now }),
      change: result.change,
    };
  }

  // ── Archive, delete, order ────────────────────────────────────────────────────────────────────

  /** Archives a habit (out of active views, check-ins refused); archiving it again is a no-op. */
  archive(userId: string, habitId: string, expectedVersion?: number, options: { now?: Date } = {}) {
    const now = options.now ?? new Date();
    return this.changeState(userId, habitId, now, async (tx, row) => {
      if (row.archivedAt !== null) return false;
      if (expectedVersion !== undefined && expectedVersion !== row.version) {
        throw versionConflict(row.version);
      }
      await tx.habit.update({
        where: { id: habitId },
        data: { archivedAt: now, version: { increment: 1 } },
      });
      return true;
    });
  }

  /** Restores an archived habit to the end of the active list; restoring an active one is a no-op. */
  restore(userId: string, habitId: string, expectedVersion?: number, options: { now?: Date } = {}) {
    const now = options.now ?? new Date();
    return this.changeState(userId, habitId, now, async (tx, row) => {
      if (row.archivedAt === null) return false;
      if (expectedVersion !== undefined && expectedVersion !== row.version) {
        throw versionConflict(row.version);
      }
      const position = await nextHabitPosition(tx, userId);
      await tx.habit.update({
        where: { id: habitId },
        data: { archivedAt: null, position, version: { increment: 1 } },
      });
      return true;
    });
  }

  /**
   * Soft-deletes a habit: hidden everywhere (404) but the deleted list and the export, restorable
   * for {@link HABIT_DELETED_RESTORE_DAYS} days, then purged with its history by the daily job.
   * Deleting it again inside the window is a no-op.
   */
  async delete(
    userId: string,
    habitId: string,
    expectedVersion?: number,
    options: { now?: Date } = {},
  ): Promise<void> {
    if (!UUID.test(habitId)) throw new HabitNotFoundError();
    const now = options.now ?? new Date();
    await this.prisma.$transaction(async (tx) => {
      await lockHabitList(tx, userId);
      const row = await lockHabitRow(tx, userId, habitId, { deleted: 'include' });
      if (!row || !this.restorable(row, now)) throw new HabitNotFoundError();
      if (row.deletedAt !== null) return;
      if (expectedVersion !== undefined && expectedVersion !== row.version) {
        throw versionConflict(row.version);
      }
      await tx.habit.update({
        where: { id: habitId },
        data: { deletedAt: now, version: { increment: 1 } },
      });
    });
  }

  /**
   * Brings a deleted habit back (inside the restore window) as it was — archived or active; an
   * active one goes to the end of the list. Undeleting a habit that is not deleted is a no-op.
   */
  async undelete(
    userId: string,
    habitId: string,
    expectedVersion?: number,
    options: { now?: Date } = {},
  ): Promise<HabitDetail> {
    if (!UUID.test(habitId)) throw new HabitNotFoundError();
    const now = options.now ?? new Date();
    await this.prisma.$transaction(async (tx) => {
      await lockHabitList(tx, userId);
      const row = await lockHabitRow(tx, userId, habitId, { deleted: 'include' });
      if (!row || !this.restorable(row, now)) throw new HabitNotFoundError();
      if (row.deletedAt === null) return;
      if (expectedVersion !== undefined && expectedVersion !== row.version) {
        throw versionConflict(row.version);
      }
      const position = row.archivedAt === null ? await nextHabitPosition(tx, userId) : undefined;
      await tx.habit.update({
        where: { id: habitId },
        data: {
          deletedAt: null,
          ...(position === undefined ? {} : { position }),
          version: { increment: 1 },
        },
      });
    });
    return this.get(userId, habitId, { now });
  }

  /** Not deleted, or deleted less than the restore window ago. */
  private restorable(row: HabitRow, now: Date): boolean {
    return (
      row.deletedAt === null || row.deletedAt.getTime() >= now.getTime() - HABIT_DELETED_RESTORE_MS
    );
  }

  /**
   * Sets a new order of the user's active habits. `habitIds` must be exactly the active habits,
   * each once: an id that is not one of the user's habits → not found; one of their archived
   * habits, or a missing active one (the list changed since it was read) → `ORDER_MISMATCH`.
   * Runs under the user's habit-list lock, so concurrent reorders apply one after the other and
   * the result is always exactly one of the submitted orders. Positions become 0..n-1; rows
   * already in place are not written; `version` is not bumped.
   */
  async reorder(userId: string, habitIds: readonly string[]): Promise<HabitOrder> {
    const ids = habitIds.map((id) => id.toLowerCase());
    return this.prisma.$transaction(async (tx) => {
      await lockHabitList(tx, userId);
      const active = await tx.habit.findMany({
        where: { userId, archivedAt: null, deletedAt: null },
        select: { id: true, position: true },
      });
      const activeIds = new Set(active.map((h) => h.id));
      const unknown = ids.filter((id) => !activeIds.has(id));
      if (unknown.length > 0) {
        const owned = await tx.habit.count({
          where: { userId, deletedAt: null, id: { in: unknown } },
        });
        if (owned < unknown.length) throw new HabitNotFoundError();
      }
      if (unknown.length > 0 || ids.length !== active.length) {
        throw new HabitWriteError(
          'ORDER_MISMATCH',
          'The order must list every active habit exactly once; read the list again',
          { expected: active.length, received: ids.length },
        );
      }
      const positionOf = new Map(active.map((h) => [h.id, h.position]));
      // Fixed (id) order of the writes: concurrent writers lock rows in the same sequence.
      const writes = ids
        .map((id, position) => ({ id, position }))
        .filter(({ id, position }) => positionOf.get(id) !== position)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const { id, position } of writes) {
        await tx.habit.update({ where: { id }, data: { position } });
      }
      const rows = await tx.habit.findMany({
        where: { userId, archivedAt: null, deletedAt: null },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      return { data: rows.map(toHabit) };
    });
  }

  /** Runs a state change under the list lock and the habit row lock, then reads the habit. */
  private async changeState(
    userId: string,
    habitId: string,
    now: Date,
    change: (tx: DatabaseTransaction, row: HabitRow) => Promise<boolean>,
  ): Promise<HabitDetail> {
    if (!UUID.test(habitId)) throw new HabitNotFoundError();
    await this.prisma.$transaction(async (tx) => {
      await lockHabitList(tx, userId);
      const row = await lockHabitRow(tx, userId, habitId);
      if (!row) throw new HabitNotFoundError();
      await change(tx, row);
    });
    return this.get(userId, habitId, { now });
  }
}
