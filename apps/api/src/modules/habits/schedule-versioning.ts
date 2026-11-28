import {
  addDays,
  computeSchedule,
  ScheduleInputError,
  versionIdOn,
  type ScheduleVersionInput,
} from '@habit/habit-engine';
import type {
  HabitCalendar,
  HabitScheduleRule,
  HabitScheduleVersion,
  HabitScheduleVersionSnapshot,
  HabitTarget,
  HabitType,
  HabitWeekStart,
} from '@habit/shared-types';
import {
  habitRuleIssues,
  resolveScheduleRule,
  type HabitRuleIssue,
  type HabitScheduleChangeRequest,
} from '@habit/shared-validation';

/**
 * Schedule versioning rules (backlog P3-03, ADR-0030) as a pure function: given a habit, its
 * stored versions, the user's local "today" and a change request, decide what to write. The
 * service (`HabitScheduleService`) runs the plan in one transaction under a row lock; keeping the
 * decision here makes every rule unit-testable without a database.
 *
 * The rules, for a change effective from local date E (default: today, or the habit's start if
 * that is later):
 * - E must lie in the habit's life: `startsOn ≤ E` and, for a habit with an end, `E ≤ endsOn`.
 * - V is the version in effect on E (found with the engine's `versionIdOn`).
 * - New rules equal to V's (schedule, target, grace days, week start, calendar) → `unchanged`,
 *   nothing is written.
 * - V starts on E → `replace`: V keeps its id and range, its rules are rewritten.
 * - V starts before E → `split`: V is closed the day before E (`effective_to = E`) and a new
 *   version opens on E, running until V's old end (an already scheduled later version stays).
 * - E before today → a **historical correction**: allowed only with a reason, recorded in the
 *   audit trail with the number of recorded days it re-judged. Without one, past days (< today)
 *   always keep the version — and so the rules — they were judged by.
 * - An interval schedule without an anchor is anchored on E.
 * - Every new version snapshots the user's current week start and calendar.
 */

/** Why a schedule change was refused. */
export type HabitScheduleChangeErrorCode =
  /** The rules do not fit the habit's type (see `issues`). */
  | 'INVALID_RULES'
  /** The effective date is before the habit's first day. */
  | 'EFFECTIVE_BEFORE_START'
  /** The effective date is after the habit's last day. */
  | 'EFFECTIVE_AFTER_END'
  /** The change starts before the user's today (a historical correction) and has no reason. */
  | 'REASON_REQUIRED'
  /** No stored version covers the effective date (versions are contiguous from the start). */
  | 'NO_VERSION_ON_DATE'
  /** The stored versions are inconsistent (the engine refused them). */
  | 'INVALID_VERSIONS'
  /** The habit changed since the client read it, or a concurrent change won. */
  | 'VERSION_CONFLICT'
  /** The change would leave a recorded day without a version. */
  | 'ORPHANED_RECORDS';

export class HabitScheduleChangeError extends Error {
  constructor(
    readonly code: HabitScheduleChangeErrorCode,
    message: string,
    readonly issues: readonly HabitRuleIssue[] = [],
  ) {
    super(message);
    this.name = 'HabitScheduleChangeError';
  }
}

/** The habit's own rules of one version, plus the calendar settings its periods use. */
export interface VersionRules {
  schedule: HabitScheduleRule;
  target: HabitTarget | null;
  graceDays: number;
  weekStart: HabitWeekStart;
  calendar: HabitCalendar;
}

export interface ScheduleSettings {
  weekStart: HabitWeekStart;
  calendar: HabitCalendar;
}

export interface PlanScheduleChangeInput {
  habit: { type: HabitType; startsOn: string; endsOn: string | null };
  /** All stored versions of the habit, any order. */
  versions: readonly HabitScheduleVersion[];
  /** The user's local date now (engine `localDateAt` in the profile time zone). */
  today: string;
  /** The user's current week start and calendar, snapshotted onto what is written. */
  settings: ScheduleSettings;
  request: HabitScheduleChangeRequest;
}

interface PlanBase {
  effectiveFrom: string;
  /** The user's today the plan was made for. */
  today: string;
  isCorrection: boolean;
  reason: string | null;
  /** The version in effect on `effectiveFrom` before the change. */
  previous: HabitScheduleVersion;
}

export type SchedulePlan =
  | (PlanBase & { operation: 'unchanged' })
  | (PlanBase & {
      operation: 'replace';
      rules: VersionRules;
      /**
       * Past local dates `[effectiveFrom, rejudgedUntil)` the change re-judges (corrections only;
       * `null` when no past day changes).
       */
      rejudgedUntil: string | null;
    })
  | (PlanBase & {
      operation: 'split';
      /** The new version's range: `[effectiveFrom, effectiveTo)`; `effectiveTo` = V's old end. */
      effectiveTo: string | null;
      rules: VersionRules;
      rejudgedUntil: string | null;
    });

/** The rules of a stored version (for comparisons and snapshots). */
export function rulesOf(version: HabitScheduleVersion): VersionRules {
  return {
    schedule: version.schedule,
    target: version.target,
    graceDays: version.graceDays,
    weekStart: version.weekStart,
    calendar: version.calendar,
  };
}

/** A canonical, key-ordered form of a version's rules, so equal rules compare equal. */
function canonicalRules(rules: VersionRules): string {
  const { schedule } = rules;
  let rule: unknown[];
  switch (schedule.kind) {
    case 'daily':
      rule = ['daily'];
      break;
    case 'weekdays':
      rule = ['weekdays', [...schedule.daysOfWeek].sort((a, b) => a - b)];
      break;
    case 'monthly_days':
      rule = ['monthly_days', [...schedule.daysOfMonth].sort((a, b) => a - b)];
      break;
    case 'interval':
      rule = ['interval', schedule.intervalDays, schedule.anchorDate];
      break;
    case 'times_per_period':
      rule = ['times_per_period', schedule.period, schedule.timesPerPeriod];
      break;
  }
  return JSON.stringify([
    rule,
    rules.target ? [rules.target.comparison, rules.target.value] : null,
    rules.graceDays,
    rules.weekStart,
    rules.calendar,
  ]);
}

export function sameRules(a: VersionRules, b: VersionRules): boolean {
  return canonicalRules(a) === canonicalRules(b);
}

/** A version as the engine reads it. */
export function toEngineVersion(version: HabitScheduleVersion): ScheduleVersionInput {
  return {
    id: version.id,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    schedule: version.schedule,
    graceDays: version.graceDays,
    weekStart: version.weekStart,
    calendar: version.calendar,
  };
}

/** A version as an audit snapshot (the contract without `createdAt`). */
export function snapshotOf(version: HabitScheduleVersion): HabitScheduleVersionSnapshot {
  return {
    id: version.id,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    schedule: version.schedule,
    target: version.target,
    graceDays: version.graceDays,
    weekStart: version.weekStart,
    calendar: version.calendar,
  };
}

const minDate = (a: string, b: string): string => (a < b ? a : b);

/**
 * Validates a complete version set with the engine: ranges must not overlap and every rule must
 * be one the engine computes. Throws `INVALID_VERSIONS` otherwise.
 */
export function assertEngineAccepts(
  habit: PlanScheduleChangeInput['habit'],
  versions: readonly ScheduleVersionInput[],
  day: string,
): void {
  try {
    computeSchedule({
      startsOn: habit.startsOn,
      endsOn: habit.endsOn,
      versions,
      pauses: [],
      range: { from: day, to: day },
    });
  } catch (error) {
    if (error instanceof ScheduleInputError) {
      throw new HabitScheduleChangeError(
        'INVALID_VERSIONS',
        `Schedule versions refused by the engine: ${error.code}`,
      );
    }
    throw error;
  }
}

/** Decides what a schedule change writes. Throws {@link HabitScheduleChangeError}. */
export function planScheduleChange(input: PlanScheduleChangeInput): SchedulePlan {
  const { habit, versions, today, settings, request } = input;
  const effectiveFrom = request.effectiveFrom ?? (today < habit.startsOn ? habit.startsOn : today);

  if (effectiveFrom < habit.startsOn) {
    throw new HabitScheduleChangeError(
      'EFFECTIVE_BEFORE_START',
      'A schedule change cannot start before the habit does',
    );
  }
  if (habit.endsOn !== null && effectiveFrom > habit.endsOn) {
    throw new HabitScheduleChangeError(
      'EFFECTIVE_AFTER_END',
      'A schedule change cannot start after the habit ends',
    );
  }
  const isCorrection = effectiveFrom < today;
  const reason = request.reason ?? null;
  if (isCorrection && reason === null) {
    throw new HabitScheduleChangeError(
      'REASON_REQUIRED',
      'A change that starts before today is a historical correction and needs a reason',
    );
  }

  const schedule = resolveScheduleRule(request.schedule, effectiveFrom);
  const issues = habitRuleIssues(habit.type, {
    schedule,
    target: request.target,
    graceDays: request.graceDays,
  });
  if (issues.length > 0) {
    throw new HabitScheduleChangeError(
      'INVALID_RULES',
      'The rules do not fit the habit type',
      issues,
    );
  }
  const rules: VersionRules = {
    schedule,
    target: request.target,
    graceDays: request.graceDays,
    weekStart: settings.weekStart,
    calendar: settings.calendar,
  };

  let previousId: string | null;
  try {
    previousId = versionIdOn(versions.map(toEngineVersion), effectiveFrom);
  } catch (error) {
    if (error instanceof ScheduleInputError) {
      throw new HabitScheduleChangeError(
        'INVALID_VERSIONS',
        `Stored schedule versions refused by the engine: ${error.code}`,
      );
    }
    throw error;
  }
  const previous = versions.find((v) => v.id === previousId);
  if (!previous) {
    throw new HabitScheduleChangeError(
      'NO_VERSION_ON_DATE',
      'No schedule version covers the effective date',
    );
  }

  const base: PlanBase = { effectiveFrom, today, isCorrection, reason, previous };
  if (sameRules(rulesOf(previous), rules)) return { ...base, operation: 'unchanged' };

  const end = previous.effectiveTo;
  const rejudgedUntil = isCorrection ? (end === null ? today : minDate(end, today)) : null;
  if (previous.effectiveFrom === effectiveFrom) {
    return { ...base, operation: 'replace', rules, rejudgedUntil };
  }
  return { ...base, operation: 'split', effectiveTo: end, rules, rejudgedUntil };
}

/**
 * The version set after `plan` is applied — what the service writes — with `newId` for the
 * version a split opens. Used to check the result with the engine before writing.
 */
export function versionsAfter(
  versions: readonly HabitScheduleVersion[],
  plan: SchedulePlan,
  newId: string,
  createdAt: string,
): HabitScheduleVersion[] {
  if (plan.operation === 'unchanged') return [...versions];
  const result: HabitScheduleVersion[] = [];
  for (const version of versions) {
    if (version.id !== plan.previous.id) {
      result.push(version);
    } else if (plan.operation === 'replace') {
      result.push({ ...version, ...plan.rules });
    } else {
      result.push({ ...version, effectiveTo: plan.effectiveFrom });
      result.push({
        id: newId,
        effectiveFrom: plan.effectiveFrom,
        effectiveTo: plan.effectiveTo,
        ...plan.rules,
        createdAt,
      });
    }
  }
  return result.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

/**
 * Checks the planned result with the engine: no overlaps, valid rules, the changed version in
 * effect on the effective date and — for a split — the closed version still in effect the day
 * before. Throws `INVALID_VERSIONS` on any mismatch (a bug, never user input).
 */
export function assertPlanResult(
  habit: PlanScheduleChangeInput['habit'],
  plan: Exclude<SchedulePlan, { operation: 'unchanged' }>,
  after: readonly HabitScheduleVersion[],
  changedId: string,
): void {
  const engineVersions = after.map(toEngineVersion);
  assertEngineAccepts(habit, engineVersions, plan.effectiveFrom);
  const onDate = versionIdOn(engineVersions, plan.effectiveFrom);
  const dayBefore =
    plan.operation === 'split'
      ? versionIdOn(engineVersions, addDays(plan.effectiveFrom, -1))
      : null;
  if (onDate !== changedId || (plan.operation === 'split' && dayBefore !== plan.previous.id)) {
    throw new HabitScheduleChangeError(
      'INVALID_VERSIONS',
      'The planned versions do not hand over on the effective date',
    );
  }
}
