/**
 * Habit domain contracts (backlog P3-01, ADR-0028): how habits, their schedule versions and
 * recorded days are represented outside the database — in the data export now, and in the habits
 * API (P3-06), check-ins (P3-04) and the weekly matrix (P3-07) later. Input rules live in
 * `@habit/shared-validation`; the literal lists repeat its lists (this package has no
 * dependencies) and the API asserts that both agree with the database enums.
 *
 * Dates are ISO `YYYY-MM-DD` local calendar dates (Gregorian); instants are ISO 8601 UTC strings.
 */

export const HABIT_TYPE_VALUES = [
  'binary',
  'numeric',
  'duration',
  'frequency',
  'negative',
  'custom',
] as const;
/** The six habit types of PRD §3.1; fixed for the life of a habit. */
export type HabitType = (typeof HABIT_TYPE_VALUES)[number];

export type HabitTargetComparison = 'at_least' | 'at_most';
export type HabitSchedulePeriod = 'week' | 'month';

/** When a habit is due. ISO weekdays: 1 = Monday … 7 = Sunday; day of month -1 = last day. */
export type HabitScheduleRule =
  | { kind: 'daily' }
  | { kind: 'weekdays'; daysOfWeek: number[] }
  | { kind: 'monthly_days'; daysOfMonth: number[] }
  | { kind: 'interval'; intervalDays: number; anchorDate: string }
  | { kind: 'times_per_period'; period: HabitSchedulePeriod; timesPerPeriod: number };

export type HabitScheduleKind = HabitScheduleRule['kind'];

/** A daily target: duration in seconds, negative in lapses, numeric/custom in the habit's unit. */
export interface HabitTarget {
  comparison: HabitTargetComparison;
  value: number;
}

/** First day of the week a version's weekly periods are counted from (ADR-0024 values). */
export type HabitWeekStart = 'saturday' | 'sunday' | 'monday';
/** Calendar of a version's months (ADR-0024 values). */
export type HabitCalendar = 'gregorian' | 'solar_hijri';

/**
 * One version of a habit's rules, in effect for local dates [effectiveFrom, effectiveTo).
 * `weekStart` and `calendar` are the user's preferences when the version was written (P3-03,
 * ADR-0030): its weeks and months are counted in them, whatever the preferences are later.
 */
export interface HabitScheduleVersion {
  id: string;
  effectiveFrom: string;
  /** Exclusive; `null` while the version is current. */
  effectiveTo: string | null;
  schedule: HabitScheduleRule;
  target: HabitTarget | null;
  graceDays: number;
  weekStart: HabitWeekStart;
  calendar: HabitCalendar;
  createdAt: string;
}

/** What a schedule change did (P3-03, ADR-0030). */
export type HabitScheduleOperation = 'create' | 'split' | 'replace';

/** A schedule version as an audit snapshot (no `createdAt`). */
export type HabitScheduleVersionSnapshot = Omit<HabitScheduleVersion, 'createdAt'>;

/**
 * One entry of a habit's append-only schedule audit trail (P3-03, ADR-0030). A change that starts
 * before the user's local "today" re-judges past days: it is a historical correction, carries a
 * reason, and counts the recorded days it re-judged.
 */
export interface HabitScheduleChange {
  id: string;
  habitId: string;
  /** The version created (create, split) or rewritten (replace). */
  versionId: string;
  operation: HabitScheduleOperation;
  effectiveFrom: string;
  /** The user's local date when the change was made. */
  localToday: string;
  isCorrection: boolean;
  reason: string | null;
  affectedRecordedDays: number;
  /** The affected versions as they were (`null` for create). */
  before: HabitScheduleVersionSnapshot[] | null;
  /** The affected versions as written. */
  after: HabitScheduleVersionSnapshot[];
  createdAt: string;
}

export interface HabitCategory {
  id: string;
  name: string;
  /** Design-palette token, never a raw colour. */
  color: string | null;
  icon: string | null;
  position: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Habit {
  id: string;
  categoryId: string | null;
  type: HabitType;
  name: string;
  description: string | null;
  unit: string | null;
  icon: string | null;
  color: string | null;
  /** First local date (inclusive). */
  startsOn: string;
  /** Last local date (inclusive); `null` = open-ended. */
  endsOn: string | null;
  /** Local `HH:MM`, or `null` for any time. */
  preferredTime: string | null;
  position: number;
  /** Optimistic-concurrency version (offline edits, Phase 8). */
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the user recorded for one habit on one local date. Days without a record are not stored;
 * their status is computed (see {@link HabitOccurrenceStatus}).
 */
export interface HabitOccurrenceRecord {
  habitId: string;
  localDate: string;
  /** `null` exactly when `skipped`. */
  value: number | null;
  skipped: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Status of a habit on a day (PRD §3.1), always **computed** by the completion logic (P3-04) from
 * the schedule version in effect, pauses and the recorded value — never stored.
 */
export type HabitOccurrenceStatus =
  'completed' | 'missed' | 'due' | 'skipped' | 'paused' | 'not_scheduled';

export interface HabitNote {
  id: string;
  habitId: string;
  localDate: string | null;
  body: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** A pause of one habit, or a vacation of all habits when `habitId` is `null` (inclusive dates). */
export interface HabitPause {
  id: string;
  habitId: string | null;
  startsOn: string;
  endsOn: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Statuses and check-ins (P3-04, ADR-0031) ────────────────────────────────────────────────────

/** Whether a day lies before, on or after the user's today (in the profile time zone). */
export type HabitDayTiming = 'past' | 'today' | 'future';

/** The schedule engine's state of a day (ADR-0029). */
export type HabitScheduleDayState = 'due' | 'flexible' | 'off' | 'paused' | 'inactive';
export type HabitScheduleRuleState = 'due' | 'flexible' | 'off';
export type HabitInactiveReason = 'before_start' | 'after_end' | 'archived' | 'no_version';

/** How a recorded value compares with the day's target. */
export interface HabitDayProgress {
  value: number;
  /** The target of the version in effect (`null` for binary/frequency: done = 1). */
  target: HabitTarget | null;
  met: boolean;
  /** `at_least` (or binary/frequency) only: some progress, not yet the target. */
  partial: boolean;
  /** 0..100 (see ADR-0031). */
  percent: number;
}

/** The computed status of one habit on one local date (never stored, ADR-0028). */
export interface HabitDayStatus {
  date: string;
  status: HabitOccurrenceStatus;
  timing: HabitDayTiming;
  scheduleState: HabitScheduleDayState;
  inactiveReason: HabitInactiveReason | null;
  pausedState: HabitScheduleRuleState | null;
  /** The schedule version in effect that day (derived, ADR-0028). */
  versionId: string | null;
  graceDays: number | null;
  record: { value: number | null; skipped: boolean } | null;
  progress: HabitDayProgress | null;
  /** Last local date a Due day can still be completed before it counts as Missed. */
  openUntil: string | null;
  /** Index into the response's `periods` (frequency habits), else `null`. */
  period: number | null;
}

export type HabitPeriodStatusValue = 'met' | 'in_progress' | 'missed' | 'not_required';

/** One week or month of a "N times per period" (frequency) habit, judged as a whole. */
export interface HabitPeriodStatus {
  versionId: string;
  kind: HabitSchedulePeriod;
  start: string;
  end: string;
  totalDays: number;
  coveredDays: number;
  pausedDays: number;
  activeDays: number;
  timesPerPeriod: number;
  /** Prorated by the schedule (ADR-0029). */
  required: number;
  partial: boolean;
  skippedDays: number;
  /** Completions needed after skips (ADR-0031). */
  target: number;
  completed: number;
  remaining: number;
  graceDays: number;
  openUntil: string;
  status: HabitPeriodStatusValue;
}

/** Statuses of one habit over a date range. */
export interface HabitStatusRange {
  habitId: string;
  /** The user's local date the statuses were computed for. */
  today: string;
  from: string;
  to: string;
  days: HabitDayStatus[];
  periods: HabitPeriodStatus[];
}

export const HABIT_CHECK_IN_ACTIONS = ['set', 'skip', 'clear'] as const;
/** What a check-in does to a day: record a value, excuse the day, or remove the record. */
export type HabitCheckInAction = (typeof HABIT_CHECK_IN_ACTIONS)[number];

/** One accepted check-in operation (append-only log; its `operationId` makes retries idempotent). */
export interface HabitCheckIn {
  id: string;
  habitId: string;
  /** The client-generated operation id (UUID). */
  operationId: string;
  localDate: string;
  action: HabitCheckInAction;
  /** Set exactly for `set`. */
  value: number | null;
  /** Whether the operation changed the stored record (a repeat of the same value does not). */
  changed: boolean;
  /** The record's `version` after the operation, `null` when no record remains. */
  occurrenceVersion: number | null;
  /** The user's local date when the operation was accepted. */
  localToday: string;
  createdAt: string;
}

/** Answer to a check-in: what was accepted, the day's record and its status now. */
export interface HabitCheckInResult {
  /** `true` when this operation id had already been accepted: nothing was written again. */
  replayed: boolean;
  checkIn: HabitCheckIn;
  occurrence: HabitOccurrenceRecord | null;
  day: HabitDayStatus;
  /** The day's period (frequency habits), else `null`. */
  period: HabitPeriodStatus | null;
}
