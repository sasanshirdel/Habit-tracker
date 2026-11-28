import { Injectable, Logger } from '@nestjs/common';
import {
  checkInRefusal,
  computeSchedule,
  computeStatuses,
  localDateAt,
  statusRecordRange,
  type CheckInRefusal,
  type StatusVersionInput,
} from '@habit/habit-engine';
import type {
  HabitCheckInResult,
  HabitDayStatus,
  HabitPeriodStatus,
  HabitStatusRange,
} from '@habit/shared-types';
import {
  occurrenceValueIssue,
  type HabitCheckInRequest,
  type HabitStatusRangeQuery,
} from '@habit/shared-validation';
import { PrismaService, type DatabaseTransaction } from '../../database/index.js';
import {
  Prisma,
  type Habit as HabitRow,
  type HabitCheckIn as HabitCheckInRow,
  type HabitOccurrence as HabitOccurrenceRow,
} from '../../generated/prisma/client.js';
import {
  fromDbDate,
  toDbDate,
  toHabitCheckIn,
  toOccurrenceRecord,
  toScheduleVersion,
} from './habit-mappers.js';
import {
  HabitNotFoundError,
  readScheduleContext,
  type ScheduleContext,
} from './habit-schedule.service.js';

/** Why a check-in was refused (ADR-0031); the HTTP layer maps each to an API error code. */
export type HabitCheckInErrorCode =
  | CheckInRefusal
  | 'HABIT_ARCHIVED'
  | 'INVALID_VALUE'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED';

export class HabitCheckInError extends Error {
  override readonly name = 'HabitCheckInError';

  constructor(
    readonly code: HabitCheckInErrorCode,
    message: string,
    /** Safe, structured details (never the rejected value). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = 'P2002';
const OPERATION_ID_CONSTRAINT = 'habit_check_ins_user_id_operation_id_key';

/** Values have at most 3 decimals (`numeric(12,3)`): compare as integers. */
const milli = (value: number): number => Math.round(value * 1000);
const decimal = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : value.toNumber();

/** A unique violation on the operation id: a concurrent request with the same id won. */
function isOperationIdViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== UNIQUE_VIOLATION) {
    return false;
  }
  const text = `${error.message} ${JSON.stringify(error.meta ?? {})}`;
  return text.includes(OPERATION_ID_CONSTRAINT) || text.includes('operation_id');
}

/** Everything about a habit the status computation needs (besides the records). */
interface HabitFacts {
  row: HabitRow;
  versions: StatusVersionInput[];
  pauses: { startsOn: string; endsOn: string | null }[];
  archivedOn: string | null;
}

/** Does the stored record already hold exactly what this operation asks for? */
function holds(existing: HabitOccurrenceRow | null, request: HabitCheckInRequest): boolean {
  switch (request.action) {
    case 'clear':
      return existing === null;
    case 'skip':
      return existing?.skipped === true;
    case 'set':
      return (
        existing !== null &&
        !existing.skipped &&
        existing.value !== null &&
        milli(existing.value.toNumber()) === milli(request.value as number)
      );
  }
}

/** Is a stored operation the same request as this one (same habit, day, action and value)? */
function sameOperation(
  event: HabitCheckInRow,
  habitId: string,
  request: HabitCheckInRequest,
): boolean {
  const stored = decimal(event.value);
  return (
    event.habitId === habitId &&
    fromDbDate(event.localDate) === request.localDate &&
    event.action === request.action &&
    (stored === null
      ? request.value === undefined
      : request.value !== undefined && milli(stored) === milli(request.value))
  );
}

/**
 * Check-ins and occurrence statuses (backlog P3-04, ADR-0031).
 *
 * `checkIn` records, updates or clears one day of a habit — a value or a skip — in one
 * transaction under the habit's row lock (`SELECT … FOR UPDATE`, the same lock schedule changes
 * take): check-ins of one habit, and schedule changes of it, run one after the other, so the
 * version in effect, the existing record and the record's `version` cannot change underneath.
 * Every accepted operation is appended to `habit_check_ins` with the client's operation id
 * (unique per user): a retry with the same id is answered from that log without writing again
 * ("replayed"), and the same id with a different request is refused. `expectedVersion` makes a
 * write conditional on the record the client last saw (offline clients, PRD §8).
 *
 * `statuses` derives Completed / Missed / Due / Skipped / Paused / Not scheduled and progress for
 * a date range with the pure engine (`computeStatuses`, `@habit/habit-engine`). "Today" is always
 * the user's local date in the profile time zone.
 */
@Injectable()
export class HabitCheckInService {
  private readonly logger = new Logger('HabitCheckIn');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Applies one check-in (already parsed with `habitCheckInSchema`) to one of the user's habits.
   * Throws `HabitNotFoundError` or `HabitCheckInError`.
   */
  async checkIn(
    userId: string,
    habitId: string,
    request: HabitCheckInRequest,
    options: { now?: Date } = {},
  ): Promise<HabitCheckInResult> {
    if (!UUID.test(habitId) || !UUID.test(userId)) throw new HabitNotFoundError();
    const now = options.now ?? new Date();
    // Fast path for retries: answered without taking the habit's lock.
    const earlier = await this.findOperation(this.prisma, userId, request.operationId);
    if (earlier) return this.replay(this.prisma, userId, habitId, request, earlier, now);
    try {
      return await this.prisma.$transaction((tx) =>
        this.applyInTransaction(tx, userId, habitId, request, now),
      );
    } catch (error) {
      if (isOperationIdViolation(error)) {
        // The same operation id was accepted concurrently (for another habit's lock).
        const winner = await this.findOperation(this.prisma, userId, request.operationId);
        if (winner) return this.replay(this.prisma, userId, habitId, request, winner, now);
      }
      throw error;
    }
  }

  /** Statuses and progress of one habit for `range` (archived habits included, deleted not). */
  async statuses(
    userId: string,
    habitId: string,
    range: HabitStatusRangeQuery,
    options: { now?: Date } = {},
  ): Promise<HabitStatusRange> {
    if (!UUID.test(habitId) || !UUID.test(userId)) throw new HabitNotFoundError();
    const now = options.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.habit.findFirst({ where: { id: habitId, userId, deletedAt: null } });
      if (!row) throw new HabitNotFoundError();
      const context = await readScheduleContext(tx, userId, now);
      const facts = await this.loadFacts(tx, row, context);
      const result = await this.computeRange(tx, facts, context, range);
      return { habitId, ...result };
    });
  }

  // ── Writing ───────────────────────────────────────────────────────────────────────────────────

  private async applyInTransaction(
    tx: DatabaseTransaction,
    userId: string,
    habitId: string,
    request: HabitCheckInRequest,
    now: Date,
  ): Promise<HabitCheckInResult> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM habits
      WHERE id = ${habitId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
      FOR UPDATE`;
    if (locked.length === 0) throw new HabitNotFoundError();
    // After the lock, an operation a concurrent request committed for this habit is visible.
    const earlier = await this.findOperation(tx, userId, request.operationId);
    if (earlier) return this.replay(tx, userId, habitId, request, earlier, now);

    const row = await tx.habit.findUniqueOrThrow({ where: { id: habitId } });
    if (row.archivedAt !== null) {
      throw new HabitCheckInError('HABIT_ARCHIVED', 'The habit is archived; restore it first');
    }
    const context = await readScheduleContext(tx, userId, now);
    const facts = await this.loadFacts(tx, row, context);
    const date = request.localDate;

    const [scheduleDay] = computeSchedule({
      startsOn: fromDbDate(row.startsOn),
      endsOn: row.endsOn === null ? null : fromDbDate(row.endsOn),
      archivedOn: facts.archivedOn,
      versions: facts.versions,
      pauses: facts.pauses,
      range: { from: date, to: date },
    }).days;
    const refusal = checkInRefusal(request.action, date, context.today, scheduleDay!);
    if (refusal) throw new HabitCheckInError(refusal, REFUSAL_MESSAGES[refusal]);
    if (request.action === 'set') {
      const issue = occurrenceValueIssue(row.type, request.value as number);
      if (issue) {
        throw new HabitCheckInError('INVALID_VALUE', 'The value does not fit the habit type', {
          issues: [{ field: 'body.value', code: 'custom', message: issue }],
        });
      }
    }

    const key = { habitId_localDate: { habitId, localDate: toDbDate(date) } };
    const existing = await tx.habitOccurrence.findUnique({ where: key });
    this.assertExpectedVersion(existing, request);

    let stored: HabitOccurrenceRow | null = existing;
    let changed = false;
    if (!holds(existing, request)) {
      changed = true;
      if (request.action === 'clear') {
        await tx.habitOccurrence.delete({ where: key });
        stored = null;
      } else {
        const content = {
          value: request.action === 'set' ? (request.value as number) : null,
          skipped: request.action === 'skip',
        };
        stored = existing
          ? await tx.habitOccurrence.update({
              where: key,
              data: { ...content, version: { increment: 1 } },
            })
          : await tx.habitOccurrence.create({
              data: {
                userId,
                habitId,
                habitType: row.type,
                localDate: toDbDate(date),
                ...content,
              },
            });
      }
    }

    const event = await tx.habitCheckIn.create({
      data: {
        userId,
        habitId,
        habitType: row.type,
        operationId: request.operationId,
        localDate: toDbDate(date),
        action: request.action,
        value: request.action === 'set' ? (request.value as number) : null,
        changed,
        occurrenceVersion: stored?.version ?? null,
        localToday: toDbDate(context.today),
      },
    });
    if (date < context.today && changed) {
      // A past day changed: logged for traceability (ids and dates only, never values).
      this.logger.log({
        msg: 'habit check-in on a past day',
        userId,
        habitId,
        localDate: date,
        localToday: context.today,
        action: request.action,
      });
    }
    const { day, period } = await this.dayOf(tx, facts, context, date);
    return {
      replayed: false,
      checkIn: toHabitCheckIn(event),
      occurrence: stored ? toOccurrenceRecord(stored) : null,
      day,
      period,
    };
  }

  /**
   * `expectedVersion` (when sent) must describe the stored record: `null` = no record, a number =
   * that record version. A request that would not change anything is never a conflict (it
   * overwrites nothing); clearing a record that is already gone is not one either.
   */
  private assertExpectedVersion(
    existing: HabitOccurrenceRow | null,
    request: HabitCheckInRequest,
  ): void {
    const expected = request.expectedVersion;
    if (expected === undefined || holds(existing, request)) return;
    const current = existing?.version ?? null;
    if (current === expected) return;
    throw new HabitCheckInError('VERSION_CONFLICT', 'The day changed since it was read', {
      currentVersion: current,
    });
  }

  private findOperation(
    db: DatabaseTransaction,
    userId: string,
    operationId: string,
  ): Promise<HabitCheckInRow | null> {
    return db.habitCheckIn.findUnique({ where: { userId_operationId: { userId, operationId } } });
  }

  /** Answers a repeated operation id from the log: nothing is written again. */
  private async replay(
    db: DatabaseTransaction,
    userId: string,
    habitId: string,
    request: HabitCheckInRequest,
    event: HabitCheckInRow,
    now: Date,
  ): Promise<HabitCheckInResult> {
    if (!sameOperation(event, habitId, request)) {
      throw new HabitCheckInError(
        'IDEMPOTENCY_KEY_REUSED',
        'This operation id was already used for a different request',
      );
    }
    const row = await db.habit.findFirst({ where: { id: habitId, userId, deletedAt: null } });
    if (!row) throw new HabitNotFoundError();
    const context = await readScheduleContext(db, userId, now);
    const facts = await this.loadFacts(db, row, context);
    const date = request.localDate;
    const occurrence = await db.habitOccurrence.findUnique({
      where: { habitId_localDate: { habitId, localDate: toDbDate(date) } },
    });
    const { day, period } = await this.dayOf(db, facts, context, date);
    return {
      replayed: true,
      checkIn: toHabitCheckIn(event),
      occurrence: occurrence ? toOccurrenceRecord(occurrence) : null,
      day,
      period,
    };
  }

  // ── Reading ───────────────────────────────────────────────────────────────────────────────────

  private async loadFacts(
    db: DatabaseTransaction,
    row: HabitRow,
    context: ScheduleContext,
  ): Promise<HabitFacts> {
    const versionRows = await db.habitScheduleVersion.findMany({
      where: { habitId: row.id },
      orderBy: { effectiveFrom: 'asc' },
    });
    // The habit's pauses and the user's vacations (habit_id null) apply together (ADR-0029).
    const pauseRows = await db.habitPause.findMany({
      where: { userId: row.userId, OR: [{ habitId: row.id }, { habitId: null }] },
      orderBy: { startsOn: 'asc' },
    });
    return {
      row,
      versions: versionRows.map((v) => {
        const { createdAt: _createdAt, ...version } = toScheduleVersion(v);
        return version;
      }),
      pauses: pauseRows.map((p) => ({
        startsOn: fromDbDate(p.startsOn),
        endsOn: p.endsOn === null ? null : fromDbDate(p.endsOn),
      })),
      // The archive instant's local date in the user's zone is the first untracked day.
      archivedOn: row.archivedAt === null ? null : localDateAt(row.archivedAt, context.timeZone),
    };
  }

  private async computeRange(
    db: DatabaseTransaction,
    facts: HabitFacts,
    context: ScheduleContext,
    range: { from: string; to: string },
  ): Promise<Omit<HabitStatusRange, 'habitId'>> {
    const base = {
      startsOn: fromDbDate(facts.row.startsOn),
      endsOn: facts.row.endsOn === null ? null : fromDbDate(facts.row.endsOn),
      archivedOn: facts.archivedOn,
      versions: facts.versions,
      pauses: facts.pauses,
      range,
    };
    // Frequency periods reach beyond the range: read every record they count.
    const span = statusRecordRange(base);
    const rows = await db.habitOccurrence.findMany({
      where: {
        habitId: facts.row.id,
        localDate: { gte: toDbDate(span.from), lte: toDbDate(span.to) },
      },
      orderBy: { localDate: 'asc' },
    });
    const result = computeStatuses({
      ...base,
      habitType: facts.row.type,
      records: rows.map((r) => ({
        localDate: fromDbDate(r.localDate),
        value: decimal(r.value),
        skipped: r.skipped,
      })),
      today: context.today,
    });
    return result;
  }

  private async dayOf(
    db: DatabaseTransaction,
    facts: HabitFacts,
    context: ScheduleContext,
    date: string,
  ): Promise<{ day: HabitDayStatus; period: HabitPeriodStatus | null }> {
    const { days, periods } = await this.computeRange(db, facts, context, {
      from: date,
      to: date,
    });
    const day = days[0]!;
    return { day, period: day.period === null ? null : periods[day.period]! };
  }
}

const REFUSAL_MESSAGES: Record<CheckInRefusal, string> = {
  DATE_IN_FUTURE: 'The day is after the user’s today in their time zone',
  DATE_NOT_TRACKED: 'The habit is not tracked on that day',
  SKIP_NOT_ALLOWED: 'Only a scheduled, not paused day can be skipped',
};
