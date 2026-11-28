/**
 * Occurrence statuses and completion (backlog P3-04, ADR-0031): what a habit's day "is" —
 * Completed, Missed, Due, Skipped, Paused or Not scheduled (PRD §3.1) — and how far the user got,
 * from the schedule engine's day states, the targets of the versions in effect, what the user
 * recorded and the user's "today".
 *
 * Like the schedule engine this is a pure, deterministic function: no clock (today is an
 * argument), no I/O, no dependency. Statuses are never stored (ADR-0028): the API, the weekly
 * matrix and, later, the offline client all derive them here, so they cannot disagree.
 *
 * Rules (ADR-0031):
 * - **Not scheduled** — the engine says `inactive` (before start, after end, archived, no version)
 *   or `off` (the rule does not schedule the day). A value recorded on such a day is reported as
 *   progress but does not change the status.
 * - **Paused** — a pause or vacation covers the day (whatever the rule says, ADR-0029 open
 *   decision 5); a recorded value is reported but does not change the status.
 * - **Skipped** — the user excused a scheduled day.
 * - **Completed** — the recorded value meets the target of the version in effect on that day:
 *   `binary`/`frequency` value 1; `at_least` value ≥ target; `at_most` value ≤ target.
 * - **Missed** — not completed and the day is closed: `today > date + graceDays`. An `at_most`
 *   day whose value already exceeds the target is Missed at once (more lapses cannot undo it).
 * - **Due** — scheduled, not completed, and still open: today, a future day, or a past day within
 *   its grace days (`date + graceDays ≥ today`), where a late check-in still counts.
 * - "N times per period" (`frequency`) days are judged per **period**: completions on any covered
 *   day count (paused days included); each skipped day is excused like a one-day pause, so the
 *   period's target is prorated again over the remaining active days. An undone day is Due while
 *   its period is open and short, Not scheduled once the period's target is met (or nothing is
 *   required), and Missed when the period closed short (`today > period end + graceDays`).
 */
import type {
  HabitOccurrenceStatus,
  HabitScheduleRule,
  HabitTarget,
  HabitType,
} from '@habit/shared-types';
import { ENGINE_DATE_MAX, ENGINE_DATE_MIN, formatLocalDate, parseLocalDate } from './dates.js';
import { ScheduleInputError } from './errors.js';
import {
  computeSchedule,
  type InactiveReason,
  type ScheduleDayState,
  type ScheduleInput,
  type SchedulePeriod,
  type ScheduleResult,
  type ScheduleRuleState,
  type ScheduleVersionInput,
} from './schedule.js';

/** A schedule version with the daily target it judges recorded values against (ADR-0028). */
export interface StatusVersionInput extends ScheduleVersionInput {
  /** `null` for binary and frequency habits; required for the other types. */
  target: HabitTarget | null;
}

/** What the user recorded for one local date: a value, or a skip (ADR-0028: never both). */
export interface StatusRecordInput {
  localDate: string;
  /** `null` exactly when `skipped`. */
  value: number | null;
  skipped: boolean;
}

export interface StatusInput extends Omit<ScheduleInput, 'versions'> {
  habitType: HabitType;
  versions: readonly StatusVersionInput[];
  /**
   * The habit's records. Must contain every record within {@link statusRecordRange} of this
   * input (frequency periods reach beyond the requested range); records outside it are ignored.
   */
  records: readonly StatusRecordInput[];
  /** The user's local date now (`localDateAt(now, timeZone)`). */
  today: string;
}

/** Whether a day lies before, on or after the user's today. */
export type DayTiming = 'past' | 'today' | 'future';

/** How a recorded value compares with the day's target. */
export interface DayProgress {
  value: number;
  /** The target of the version in effect (`null` for binary/frequency: done = 1). */
  target: HabitTarget | null;
  /** The value meets the target. */
  met: boolean;
  /** `at_least` (or binary/frequency) only: some progress, not yet the target. */
  partial: boolean;
  /**
   * 0..100, whole: `at_least` → `floor(100 × value / target)` capped at 100; binary/frequency
   * → 0 or 100; `at_most` → 100 while within the limit, else 0.
   */
  percent: number;
}

export interface DayStatus {
  date: string;
  status: HabitOccurrenceStatus;
  timing: DayTiming;
  /** The engine's day state (ADR-0029). */
  scheduleState: ScheduleDayState;
  inactiveReason: InactiveReason | null;
  pausedState: ScheduleRuleState | null;
  versionId: string | null;
  graceDays: number | null;
  /** What was recorded, or `null`. */
  record: { value: number | null; skipped: boolean } | null;
  /** Set when a value is recorded on a day with a version (any state but `inactive`). */
  progress: DayProgress | null;
  /**
   * Last local date on which the day can still be completed without counting as Missed
   * (`date + graceDays`, or the period's for frequency days); `null` when nothing is due.
   */
  openUntil: string | null;
  /** Index into {@link StatusResult.periods} for days of a "N times per period" version. */
  period: number | null;
}

/** Status of one "N times per period" period. */
export type PeriodStatusValue = 'met' | 'in_progress' | 'missed' | 'not_required';

export interface PeriodStatus extends SchedulePeriod {
  /** Covered, not paused days the user skipped (each is excused like a one-day pause). */
  skippedDays: number;
  /**
   * Completions needed after skips: `min(a, ceil(timesPerPeriod × a / totalDays))` with
   * `a = activeDays − skippedDays` (equals `required` without skips).
   */
  target: number;
  /** Covered days whose recorded value is done (paused days included). */
  completed: number;
  /** `max(0, target − completed)`. */
  remaining: number;
  graceDays: number;
  /** `end + graceDays`: after this date an unmet period is Missed. */
  openUntil: string;
  status: PeriodStatusValue;
}

export interface StatusResult {
  from: string;
  to: string;
  today: string;
  /** One entry per date of the range, in order. */
  days: DayStatus[];
  /** Periods the range's days belong to, in chronological order. */
  periods: PeriodStatus[];
}

// ── Values ──────────────────────────────────────────────────────────────────────────────────────

/** Values and targets have at most 3 decimals (`numeric(12,3)`): compare them as integers. */
const milli = (value: number): number => Math.round(value * 1000);

function needsTarget(type: HabitType): boolean {
  return type !== 'binary' && type !== 'frequency';
}

/**
 * Judges one recorded value of a habit of `type` against the day's `target` (the target of the
 * version in effect on that day). Throws {@link ScheduleInputError} `INVALID_VERSION` when the
 * target does not fit the type (a bug upstream: the database refuses such versions).
 */
export function judgeValue(
  type: HabitType,
  target: HabitTarget | null,
  value: number,
): DayProgress {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ScheduleInputError('INVALID_RECORD', 'value must be a finite number ≥ 0');
  }
  if (!needsTarget(type)) {
    if (target !== null) {
      throw new ScheduleInputError('INVALID_VERSION', `${type} habits have no target`);
    }
    const met = value >= 1;
    return { value, target: null, met, partial: false, percent: met ? 100 : 0 };
  }
  if (target === null || typeof target !== 'object') {
    throw new ScheduleInputError('INVALID_VERSION', `${type} habits need a target`);
  }
  const v = milli(value);
  const t = milli(target.value);
  if (target.comparison === 'at_most') {
    const met = v <= t;
    return { value, target, met, partial: false, percent: met ? 100 : 0 };
  }
  if (t <= 0) throw new ScheduleInputError('INVALID_VERSION', 'at_least target must be > 0');
  const met = v >= t;
  return {
    value,
    target,
    met,
    partial: !met && v > 0,
    percent: met ? 100 : Math.floor((v * 100) / t),
  };
}

// ── Records ─────────────────────────────────────────────────────────────────────────────────────

type RecordMap = Map<number, StatusRecordInput>;

function indexRecords(records: readonly StatusRecordInput[]): RecordMap {
  if (!Array.isArray(records)) {
    throw new ScheduleInputError('INVALID_RECORD', 'records must be an array');
  }
  const map: RecordMap = new Map();
  for (const r of records) {
    const day = parseLocalDate(r?.localDate, 'record localDate');
    const skipped = r.skipped === true;
    if (skipped ? r.value !== null : typeof r.value !== 'number') {
      throw new ScheduleInputError(
        'INVALID_RECORD',
        `record ${r.localDate}: exactly one of value and skipped`,
      );
    }
    if (map.has(day)) {
      throw new ScheduleInputError('INVALID_RECORD', `two records for ${r.localDate}`);
    }
    map.set(day, r);
  }
  return map;
}

// ── Ranges ──────────────────────────────────────────────────────────────────────────────────────

const WINDOW_MIN = parseLocalDate(ENGINE_DATE_MIN);
const WINDOW_MAX = parseLocalDate(ENGINE_DATE_MAX);

function toScheduleInput(
  input: Omit<StatusInput, 'records' | 'today' | 'habitType'>,
  range: { from: string; to: string },
): ScheduleInput {
  return {
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    archivedOn: input.archivedOn ?? null,
    versions: input.versions,
    pauses: input.pauses,
    range,
  };
}

/** The days whose records {@link computeStatuses} needs: the range plus its whole periods. */
function extendedRange(schedule: ScheduleResult): { from: string; to: string } {
  let from = parseLocalDate(schedule.from);
  let to = parseLocalDate(schedule.to);
  for (const p of schedule.periods) {
    from = Math.min(from, Math.max(WINDOW_MIN, parseLocalDate(p.start)));
    to = Math.max(to, Math.min(WINDOW_MAX, parseLocalDate(p.end)));
  }
  return { from: formatLocalDate(from), to: formatLocalDate(to) };
}

/**
 * The inclusive local dates whose records {@link computeStatuses} reads for `input`: the requested
 * range, widened to the whole weeks/months of any "N times per period" version it touches.
 * Callers load the habit's records for this range.
 */
export function statusRecordRange(input: ScheduleInput): { from: string; to: string } {
  return extendedRange(computeSchedule(input));
}

// ── Statuses ────────────────────────────────────────────────────────────────────────────────────

function assertTypeFits(type: HabitType, versions: readonly StatusVersionInput[]): void {
  if (!Array.isArray(versions)) {
    throw new ScheduleInputError('INVALID_VERSION', 'versions must be an array');
  }
  for (const v of versions) {
    const periodic = (v?.schedule as HabitScheduleRule | undefined)?.kind === 'times_per_period';
    if (periodic !== (type === 'frequency')) {
      throw new ScheduleInputError(
        'INVALID_VERSION',
        `version ${v?.id}: only frequency habits use (and always use) times_per_period`,
      );
    }
    if (needsTarget(type) !== (v.target !== null && v.target !== undefined)) {
      throw new ScheduleInputError(
        'INVALID_VERSION',
        `version ${v.id}: ${type} habits ${needsTarget(type) ? 'need' : 'have no'} target`,
      );
    }
  }
}

/**
 * Statuses and progress of one habit for every date of `input.range`, and the status of each
 * "N times per period" period those dates belong to. Throws {@link ScheduleInputError} for
 * invalid input (see the schedule engine, plus `INVALID_RECORD` and type/target mismatches).
 */
export function computeStatuses(input: StatusInput): StatusResult {
  if (input === null || typeof input !== 'object') {
    throw new ScheduleInputError('INVALID_RANGE', 'input must be an object');
  }
  const type = input.habitType;
  if (!['binary', 'numeric', 'duration', 'frequency', 'negative', 'custom'].includes(type)) {
    throw new ScheduleInputError('INVALID_VERSION', `unknown habit type ${String(type)}`);
  }
  assertTypeFits(type, input.versions);
  const today = parseLocalDate(input.today, 'today');
  const records = indexRecords(input.records);
  const targets = new Map(input.versions.map((v) => [v.id, v.target]));

  const inRange = computeSchedule(toScheduleInput(input, input.range));
  const wide = extendedRange(inRange);
  const full =
    wide.from === inRange.from && wide.to === inRange.to
      ? inRange
      : computeSchedule(toScheduleInput(input, wide));
  const fullFrom = parseLocalDate(full.from);

  // Periods: completions and skips over all their covered days.
  const periodStats = full.periods.map(() => ({ completed: 0, skipped: 0 }));
  full.days.forEach((d, i) => {
    if (d.period === null) return;
    const record = records.get(fullFrom + i);
    if (!record) return;
    const stats = periodStats[d.period]!;
    if (record.skipped) {
      if (d.state === 'flexible') stats.skipped += 1;
    } else if (judgeValue(type, null, record.value as number).met) {
      stats.completed += 1;
    }
  });
  const graceOf = (versionId: string) => input.versions.find((v) => v.id === versionId)!.graceDays;
  const periodResults: PeriodStatus[] = full.periods.map((p, i) => {
    const { completed, skipped } = periodStats[i]!;
    const active = p.activeDays - skipped;
    const target =
      active <= 0 ? 0 : Math.min(active, Math.ceil((p.timesPerPeriod * active) / p.totalDays));
    const graceDays = graceOf(p.versionId);
    const openUntil = parseLocalDate(p.end) + graceDays;
    const status: PeriodStatusValue =
      target === 0
        ? 'not_required'
        : completed >= target
          ? 'met'
          : today > openUntil
            ? 'missed'
            : 'in_progress';
    return {
      ...p,
      skippedDays: skipped,
      target,
      completed,
      remaining: Math.max(0, target - completed),
      graceDays,
      openUntil: formatLocalDate(openUntil),
      status,
    };
  });

  // Days of the requested range.
  const offset = parseLocalDate(inRange.from) - fullFrom;
  const periodIndex = new Map<number, number>();
  const periods: PeriodStatus[] = [];
  const days: DayStatus[] = [];
  for (let i = 0; i < inRange.days.length; i += 1) {
    const d = full.days[offset + i]!;
    const day = fullFrom + offset + i;
    const record = records.get(day) ?? null;
    const timing: DayTiming = day < today ? 'past' : day === today ? 'today' : 'future';
    const target = d.versionId === null ? null : (targets.get(d.versionId) ?? null);
    const progress =
      record && !record.skipped && d.versionId !== null
        ? judgeValue(type, target, record.value as number)
        : null;

    let period: number | null = null;
    if (d.period !== null) {
      const known = periodIndex.get(d.period);
      if (known === undefined) {
        period = periods.length;
        periodIndex.set(d.period, period);
        periods.push(periodResults[d.period]!);
      } else {
        period = known;
      }
    }

    let status: HabitOccurrenceStatus;
    let openUntil: string | null = null;
    switch (d.state) {
      case 'inactive':
      case 'off':
        status = 'not_scheduled';
        break;
      case 'paused':
        status = 'paused';
        break;
      case 'due': {
        const closes = day + (d.graceDays as number);
        openUntil = formatLocalDate(closes);
        if (record?.skipped) status = 'skipped';
        else if (progress?.met) status = 'completed';
        else if (progress && target?.comparison === 'at_most') status = 'missed';
        else status = today > closes ? 'missed' : 'due';
        break;
      }
      case 'flexible': {
        const p = periodResults[d.period as number]!;
        openUntil = p.openUntil;
        if (record?.skipped) status = 'skipped';
        else if (progress?.met) status = 'completed';
        else if (p.status === 'met' || p.status === 'not_required') status = 'not_scheduled';
        else status = p.status === 'missed' ? 'missed' : 'due';
        break;
      }
    }
    days.push({
      date: d.date,
      status,
      timing,
      scheduleState: d.state,
      inactiveReason: d.inactiveReason,
      pausedState: d.pausedState,
      versionId: d.versionId,
      graceDays: d.graceDays,
      record: record ? { value: record.value, skipped: record.skipped } : null,
      progress,
      openUntil: status === 'due' || status === 'missed' ? openUntil : null,
      period,
    });
  }
  return { from: inRange.from, to: inRange.to, today: input.today, days, periods };
}

// ── Check-in rules ──────────────────────────────────────────────────────────────────────────────

/** What a check-in does to a day: record a value, excuse the day, or remove the record. */
export type CheckInAction = 'set' | 'skip' | 'clear';

/** Why a check-in is refused (ADR-0031). */
export type CheckInRefusal = 'DATE_IN_FUTURE' | 'DATE_NOT_TRACKED' | 'SKIP_NOT_ALLOWED';

/**
 * Whether a check-in on `date` may be written, given the user's `today` and the engine's state of
 * that day (`computeSchedule` for a one-day range), or why not:
 * - no action after today (`DATE_IN_FUTURE`) — the user's today in the profile time zone;
 * - `set` and `skip` only on days the habit is tracked: not before its start, after its end,
 *   archived or without a version (`DATE_NOT_TRACKED`). Values may be recorded on `off` and
 *   `paused` days (what happened is never refused; the status stays Not scheduled / Paused);
 * - `skip` only on a day that is scheduled and not paused (`due` or `flexible`):
 *   excusing a day that asks for nothing means nothing (`SKIP_NOT_ALLOWED`);
 * - `clear` on any day up to today (it only removes what is there).
 */
export function checkInRefusal(
  action: CheckInAction,
  date: string,
  today: string,
  day: { state: ScheduleDayState },
): CheckInRefusal | null {
  if (parseLocalDate(date) > parseLocalDate(today, 'today')) return 'DATE_IN_FUTURE';
  if (action === 'clear') return null;
  if (day.state === 'inactive') return 'DATE_NOT_TRACKED';
  if (action === 'skip' && day.state !== 'due' && day.state !== 'flexible') {
    return 'SKIP_NOT_ALLOWED';
  }
  return null;
}
