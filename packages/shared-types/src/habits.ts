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

/** One version of a habit's rules, in effect for local dates [effectiveFrom, effectiveTo). */
export interface HabitScheduleVersion {
  id: string;
  effectiveFrom: string;
  /** Exclusive; `null` while the version is current. */
  effectiveTo: string | null;
  schedule: HabitScheduleRule;
  target: HabitTarget | null;
  graceDays: number;
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
