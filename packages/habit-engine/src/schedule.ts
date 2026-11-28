/**
 * The schedule engine (backlog P3-02, ADR-0029): which local dates a habit is due on.
 *
 * `computeSchedule` is a pure, deterministic function of its input — the habit's start/end (and
 * archive) dates, its schedule versions, the pauses and vacations that apply to it, and a date
 * range. It returns one {@link ScheduleDay} per date of the range and, for "N times per week /
 * month" versions, the {@link SchedulePeriod}s those days belong to. It never reads a clock, the
 * database or the environment, and it does not know what the user recorded: completion and the
 * six statuses are P3-04's (Completed/Missed/Due/Skipped/Paused/Not scheduled), streaks P3-05's.
 *
 * What a day or period says never depends on the requested range: asking for one week or for two
 * years gives identical answers for the days both contain (periods are always computed over the
 * whole calendar period). A test checks this for random inputs.
 */
import type { CalendarSystem, WeekStart } from '@habit/localization';
import type { HabitScheduleRule } from '@habit/shared-types';
import {
  ENGINE_DATE_MAX,
  ENGINE_DATE_MIN,
  formatLocalDate,
  isoWeekdayOf,
  mod,
  parseLocalDate,
  type DayNumber,
} from './dates.js';
import { ScheduleInputError } from './errors.js';
import {
  assertCalendar,
  assertWeekStart,
  monthPositionOf,
  periodOfDay,
  type PeriodKind,
} from './periods.js';

/** Bounds the engine accepts; equal to `HABIT_LIMITS` in `@habit/shared-validation` (API test). */
export const ENGINE_LIMITS = {
  graceDaysMax: 7,
  intervalDaysMin: 2,
  intervalDaysMax: 365,
  timesPerWeekMax: 7,
  timesPerMonthMax: 31,
} as const;

/** `daysOfMonth` value meaning "the last day of the month". */
export const LAST_DAY = -1;

/**
 * One schedule version: the rules for local dates `[effectiveFrom, effectiveTo)` (ADR-0028), plus
 * the calendar settings its periods are counted in.
 */
export interface ScheduleVersionInput {
  id: string;
  effectiveFrom: string;
  /** Exclusive; `null` = still in effect. */
  effectiveTo: string | null;
  schedule: HabitScheduleRule;
  /** Passed through to each day (its meaning is P3-05's). */
  graceDays: number;
  /** First day of the weeks of a `times_per_period` week schedule. */
  weekStart: WeekStart;
  /** Calendar of the months of `monthly_days` and `times_per_period` month schedules. */
  calendar: CalendarSystem;
}

/** A pause of this habit, or a vacation of all habits: inclusive local dates, `null` = open. */
export interface SchedulePauseInput {
  startsOn: string;
  endsOn: string | null;
}

export interface ScheduleInput {
  /** The habit's first local date (inclusive). */
  startsOn: string;
  /** The habit's last local date (inclusive); `null` = open-ended. */
  endsOn: string | null;
  /**
   * First local date the habit is no longer tracked because it is archived (exclusive end) —
   * the archive instant's local date in the user's zone (`localDateAt`). `null` / absent = active.
   */
  archivedOn?: string | null;
  /** Any order; must not overlap (the database's EXCLUDE constraint guarantees it). */
  versions: readonly ScheduleVersionInput[];
  /** The habit's pauses and the user's vacations; may overlap each other. */
  pauses: readonly SchedulePauseInput[];
  /** Inclusive local dates within {@link ENGINE_DATE_MIN}..{@link ENGINE_DATE_MAX}. */
  range: { from: string; to: string };
}

/**
 * What the schedule says about one day:
 * - `due` — a fixed scheduled day (daily, a selected weekday, a day of the month, every N days);
 * - `flexible` — a day of a "N times per period" schedule: any day of the period may count;
 * - `off` — the habit is active and a version applies, but the rule does not schedule this day;
 * - `paused` — a pause or vacation covers the day (`pausedState` says what it would have been);
 * - `inactive` — before the start, after the end, archived, or no version covers the day.
 */
export type ScheduleDayState = 'due' | 'flexible' | 'off' | 'paused' | 'inactive';
export type ScheduleRuleState = 'due' | 'flexible' | 'off';
export type InactiveReason = 'before_start' | 'after_end' | 'archived' | 'no_version';

export interface ScheduleDay {
  date: string;
  state: ScheduleDayState;
  /** Set exactly when `state` is `inactive`. */
  inactiveReason: InactiveReason | null;
  /** The version in effect (`null` when inactive). */
  versionId: string | null;
  /** The version's grace days (`null` when inactive). */
  graceDays: number | null;
  /** Set exactly when `state` is `paused`: what the rule says about the day. */
  pausedState: ScheduleRuleState | null;
  /** Index into {@link ScheduleResult.periods} for days of a `times_per_period` version. */
  period: number | null;
}

/**
 * One calendar week or month of one `times_per_period` version. If a version starts or ends inside
 * the period, or the habit starts/ends/is archived or paused inside it, the target is prorated to
 * the active days: `required = min(activeDays, ceil(timesPerPeriod × activeDays / totalDays))`, so
 * a full period requires `timesPerPeriod` (capped at the days a short month has) and a period with
 * no active day requires nothing.
 */
export interface SchedulePeriod {
  versionId: string;
  kind: PeriodKind;
  /** First and last day of the calendar period (inclusive), even outside the requested range. */
  start: string;
  end: string;
  /** Days in the calendar period (7, or 28..31 / 29..31). */
  totalDays: number;
  /** Days of the period where this version applies and the habit is active (paused included). */
  coveredDays: number;
  /** Covered days that are paused. */
  pausedDays: number;
  /** `coveredDays - pausedDays`: the days that can count. */
  activeDays: number;
  timesPerPeriod: number;
  /** How many days of the period must count towards the target (see above). */
  required: number;
  /** `activeDays < totalDays`. */
  partial: boolean;
}

export interface ScheduleResult {
  from: string;
  to: string;
  /** One entry per date of the range, in order. */
  days: ScheduleDay[];
  /** Periods the range's days belong to, in chronological order. */
  periods: SchedulePeriod[];
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────

const WINDOW_MIN = parseLocalDate(ENGINE_DATE_MIN);
const WINDOW_MAX = parseLocalDate(ENGINE_DATE_MAX);

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const invalidRule = (message: string) => new ScheduleInputError('INVALID_RULE', message);

/** A rule compiled for fast per-day evaluation. */
type CompiledRule =
  | { kind: 'daily' }
  | { kind: 'weekdays'; mask: number }
  | { kind: 'monthly_days'; days: ReadonlySet<number>; calendar: CalendarSystem }
  | { kind: 'interval'; every: number; anchor: DayNumber }
  | {
      kind: 'times_per_period';
      period: PeriodKind;
      times: number;
      weekStart: WeekStart;
      calendar: CalendarSystem;
    };

function compileRule(rule: HabitScheduleRule, version: ScheduleVersionInput): CompiledRule {
  if (rule === null || typeof rule !== 'object') throw invalidRule('schedule must be an object');
  switch (rule.kind) {
    case 'daily':
      return { kind: 'daily' };
    case 'weekdays': {
      const days = rule.daysOfWeek;
      if (!Array.isArray(days) || days.length === 0 || !days.every((d) => isInt(d, 1, 7))) {
        throw invalidRule('daysOfWeek must be a non-empty list of ISO weekdays 1..7');
      }
      return { kind: 'weekdays', mask: days.reduce((m, d) => m | (1 << d), 0) };
    }
    case 'monthly_days': {
      const days = rule.daysOfMonth;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        !days.every((d) => d === LAST_DAY || isInt(d, 1, 31))
      ) {
        throw invalidRule('daysOfMonth must be a non-empty list of 1..31 or -1 (last day)');
      }
      assertCalendar(version.calendar);
      return { kind: 'monthly_days', days: new Set(days), calendar: version.calendar };
    }
    case 'interval': {
      if (!isInt(rule.intervalDays, ENGINE_LIMITS.intervalDaysMin, ENGINE_LIMITS.intervalDaysMax)) {
        throw invalidRule(
          `intervalDays must be an integer ${ENGINE_LIMITS.intervalDaysMin}..${ENGINE_LIMITS.intervalDaysMax}`,
        );
      }
      return {
        kind: 'interval',
        every: rule.intervalDays,
        anchor: parseLocalDate(rule.anchorDate, 'anchorDate'),
      };
    }
    case 'times_per_period': {
      if (rule.period !== 'week' && rule.period !== 'month') {
        throw invalidRule('period must be week or month');
      }
      const max =
        rule.period === 'week' ? ENGINE_LIMITS.timesPerWeekMax : ENGINE_LIMITS.timesPerMonthMax;
      if (!isInt(rule.timesPerPeriod, 1, max)) {
        throw invalidRule(`timesPerPeriod must be an integer 1..${max} per ${rule.period}`);
      }
      assertWeekStart(version.weekStart);
      assertCalendar(version.calendar);
      return {
        kind: 'times_per_period',
        period: rule.period,
        times: rule.timesPerPeriod,
        weekStart: version.weekStart,
        calendar: version.calendar,
      };
    }
    default:
      throw invalidRule(`unknown schedule kind ${String((rule as { kind?: unknown }).kind)}`);
  }
}

interface CompiledVersion {
  id: string;
  from: DayNumber;
  /** Exclusive. */
  to: DayNumber;
  graceDays: number;
  rule: CompiledRule;
}

type VersionRangeInput = Pick<ScheduleVersionInput, 'id' | 'effectiveFrom' | 'effectiveTo'>;

interface VersionRange {
  id: string;
  from: DayNumber;
  /** Exclusive. */
  to: DayNumber;
}

/** Parses, sorts and checks version ranges (no overlap); `extra` compiles the rest per version. */
function compileRanges<V extends VersionRangeInput, T extends VersionRange>(
  versions: readonly V[],
  extra: (version: V, range: VersionRange) => T,
): T[] {
  if (!Array.isArray(versions)) {
    throw new ScheduleInputError('INVALID_VERSION', 'versions must be an array');
  }
  const compiled = versions.map((v: V): T => {
    if (typeof v?.id !== 'string' || v.id.length === 0) {
      throw new ScheduleInputError('INVALID_VERSION', 'version id must be a non-empty string');
    }
    const from = parseLocalDate(v.effectiveFrom, 'effectiveFrom');
    const to =
      v.effectiveTo === null
        ? Number.POSITIVE_INFINITY
        : parseLocalDate(v.effectiveTo, 'effectiveTo');
    if (to <= from) {
      throw new ScheduleInputError(
        'INVALID_VERSION',
        `version ${v.id}: effectiveTo must be after effectiveFrom`,
      );
    }
    return extra(v, { id: v.id, from, to });
  });
  compiled.sort((a, b) => a.from - b.from);
  for (let i = 1; i < compiled.length; i += 1) {
    const prev = compiled[i - 1] as T;
    const cur = compiled[i] as T;
    if (prev.to > cur.from) {
      throw new ScheduleInputError(
        'OVERLAPPING_VERSIONS',
        `versions ${prev.id} and ${cur.id} overlap`,
      );
    }
  }
  return compiled;
}

function compileVersions(versions: readonly ScheduleVersionInput[]): CompiledVersion[] {
  return compileRanges(versions, (v, range): CompiledVersion => {
    if (!isInt(v.graceDays, 0, ENGINE_LIMITS.graceDaysMax)) {
      throw new ScheduleInputError(
        'INVALID_VERSION',
        `version ${v.id}: graceDays must be an integer 0..${ENGINE_LIMITS.graceDaysMax}`,
      );
    }
    return { ...range, graceDays: v.graceDays, rule: compileRule(v.schedule, v) };
  });
}

/** Inclusive day ranges, merged and sorted. */
function compilePauses(
  pauses: readonly SchedulePauseInput[],
): { start: DayNumber; end: DayNumber }[] {
  if (!Array.isArray(pauses))
    throw new ScheduleInputError('INVALID_PAUSE', 'pauses must be an array');
  const ranges = pauses.map((p) => {
    const start = parseLocalDate(p?.startsOn, 'pause startsOn');
    const end =
      p.endsOn === null ? Number.POSITIVE_INFINITY : parseLocalDate(p.endsOn, 'pause endsOn');
    if (end < start)
      throw new ScheduleInputError('INVALID_PAUSE', 'pause endsOn must not be before startsOn');
    return { start, end };
  });
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: DayNumber; end: DayNumber }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Index of the range containing `day` in sorted disjoint ranges, or -1 (binary search). */
function findRange<T>(
  ranges: readonly T[],
  day: DayNumber,
  startOf: (r: T) => number,
  contains: (r: T, d: number) => boolean,
): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const midIndex = (lo + hi) >> 1;
    const mid = ranges[midIndex] as T;
    if (day < startOf(mid)) hi = midIndex - 1;
    else if (contains(mid, day)) return midIndex;
    else lo = midIndex + 1;
  }
  return -1;
}

function ruleStateOf(rule: CompiledRule, day: DayNumber): ScheduleRuleState {
  switch (rule.kind) {
    case 'daily':
      return 'due';
    case 'weekdays':
      return rule.mask & (1 << isoWeekdayOf(day)) ? 'due' : 'off';
    case 'monthly_days': {
      const { dayOfMonth, monthLength } = monthPositionOf(day, rule.calendar);
      return rule.days.has(dayOfMonth) || (dayOfMonth === monthLength && rule.days.has(LAST_DAY))
        ? 'due'
        : 'off';
    }
    case 'interval':
      return mod(day - rule.anchor, rule.every) === 0 ? 'due' : 'off';
    case 'times_per_period':
      return 'flexible';
  }
}

// ── Engine ──────────────────────────────────────────────────────────────────────────────────────

/** Everything about a habit's life the per-day loop needs, compiled once. */
class CompiledSchedule {
  readonly start: DayNumber;
  readonly end: DayNumber;
  readonly archived: DayNumber;
  readonly versions: CompiledVersion[];
  readonly pauses: { start: DayNumber; end: DayNumber }[];

  constructor(input: Omit<ScheduleInput, 'range'>) {
    this.start = parseLocalDate(input.startsOn, 'startsOn');
    this.end =
      input.endsOn === null ? Number.POSITIVE_INFINITY : parseLocalDate(input.endsOn, 'endsOn');
    if (this.end < this.start) {
      throw new ScheduleInputError('INVALID_HABIT_DATES', 'endsOn must not be before startsOn');
    }
    this.archived =
      input.archivedOn === undefined || input.archivedOn === null
        ? Number.POSITIVE_INFINITY
        : parseLocalDate(input.archivedOn, 'archivedOn');
    this.versions = compileVersions(input.versions);
    this.pauses = compilePauses(input.pauses);
  }

  inactiveReason(day: DayNumber): InactiveReason | null {
    if (day < this.start) return 'before_start';
    if (day > this.end) return 'after_end';
    if (day >= this.archived) return 'archived';
    return null;
  }

  versionIndexAt(day: DayNumber): number {
    return findRange(
      this.versions,
      day,
      (v) => v.from,
      (v, d) => d < v.to,
    );
  }

  isPaused(day: DayNumber): boolean {
    return (
      findRange(
        this.pauses,
        day,
        (p) => p.start,
        (p, d) => d <= p.end,
      ) !== -1
    );
  }
}

function parseRange(range: ScheduleInput['range']): { from: DayNumber; to: DayNumber } {
  if (range === null || typeof range !== 'object') {
    throw new ScheduleInputError('INVALID_RANGE', 'range must be { from, to }');
  }
  const from = parseLocalDate(range.from, 'range.from');
  const to = parseLocalDate(range.to, 'range.to');
  if (to < from)
    throw new ScheduleInputError('INVALID_RANGE', 'range.to must not be before range.from');
  if (from < WINDOW_MIN || to > WINDOW_MAX) {
    throw new ScheduleInputError(
      'DATE_OUT_OF_WINDOW',
      `range must lie within ${ENGINE_DATE_MIN}..${ENGINE_DATE_MAX}`,
    );
  }
  return { from, to };
}

/**
 * Scheduled days and periods of one habit over `input.range` (inclusive). Throws
 * {@link ScheduleInputError} for invalid input. Cost is linear in the range length (plus the
 * days of the periods it touches); two years take a few milliseconds.
 */
export function computeSchedule(input: ScheduleInput): ScheduleResult {
  if (input === null || typeof input !== 'object') {
    throw new ScheduleInputError('INVALID_RANGE', 'input must be an object');
  }
  const { from, to } = parseRange(input.range);
  const habit = new CompiledSchedule(input);

  const days: ScheduleDay[] = [];
  const periods: SchedulePeriod[] = [];
  const periodIndex = new Map<string, number>();

  const periodFor = (
    vi: number,
    version: CompiledVersion,
    rule: Extract<CompiledRule, { kind: 'times_per_period' }>,
    day: DayNumber,
  ): number => {
    const range = periodOfDay(day, rule.period, rule);
    const key = `${vi}:${range.start}`;
    const known = periodIndex.get(key);
    if (known !== undefined) return known;
    let covered = 0;
    let paused = 0;
    for (let d = range.start; d <= range.end; d += 1) {
      if (habit.inactiveReason(d) !== null || d < version.from || d >= version.to) continue;
      covered += 1;
      if (habit.isPaused(d)) paused += 1;
    }
    const totalDays = range.end - range.start + 1;
    const activeDays = covered - paused;
    const required =
      activeDays === 0 ? 0 : Math.min(activeDays, Math.ceil((rule.times * activeDays) / totalDays));
    const index = periods.length;
    periods.push({
      versionId: version.id,
      kind: rule.period,
      start: formatLocalDate(range.start),
      end: formatLocalDate(range.end),
      totalDays,
      coveredDays: covered,
      pausedDays: paused,
      activeDays,
      timesPerPeriod: rule.times,
      required,
      partial: activeDays < totalDays,
    });
    periodIndex.set(key, index);
    return index;
  };

  for (let day = from; day <= to; day += 1) {
    const date = formatLocalDate(day);
    const reason = habit.inactiveReason(day);
    const vi = reason === null ? habit.versionIndexAt(day) : -1;
    const version = vi === -1 ? undefined : habit.versions[vi];
    if (!version) {
      days.push({
        date,
        state: 'inactive',
        inactiveReason: reason ?? 'no_version',
        versionId: null,
        graceDays: null,
        pausedState: null,
        period: null,
      });
      continue;
    }
    const ruleState = ruleStateOf(version.rule, day);
    const paused = habit.isPaused(day);
    days.push({
      date,
      state: paused ? 'paused' : ruleState,
      inactiveReason: null,
      versionId: version.id,
      graceDays: version.graceDays,
      pausedState: paused ? ruleState : null,
      period:
        version.rule.kind === 'times_per_period' ? periodFor(vi, version, version.rule, day) : null,
    });
  }

  return { from: formatLocalDate(from), to: formatLocalDate(to), days, periods };
}

/**
 * The id of the version in effect on `date`, or `null` — how P3-03/P3-04 find the rules that
 * applied to a recorded day (the version is derived, never stored on the record; ADR-0028).
 * Only the ranges are read (and checked for overlap).
 */
export function versionIdOn(versions: readonly VersionRangeInput[], date: string): string | null {
  const ranges = compileRanges(versions, (_v, range) => range);
  const day = parseLocalDate(date);
  const index = findRange(
    ranges,
    day,
    (v) => v.from,
    (v, d) => d < v.to,
  );
  return index === -1 ? null : (ranges[index] as VersionRange).id;
}
