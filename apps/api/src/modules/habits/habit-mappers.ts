import type {
  Habit,
  HabitCalendar,
  HabitCategory,
  HabitCheckIn,
  HabitNote,
  HabitOccurrenceRecord,
  HabitPause,
  HabitScheduleChange,
  HabitScheduleRule,
  HabitScheduleVersion,
  HabitScheduleVersionSnapshot,
  HabitTarget,
  HabitWeekStart,
} from '@habit/shared-types';
import { minutesToPreferredTime, type HabitRules } from '@habit/shared-validation';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  Habit as HabitRow,
  HabitCategory as HabitCategoryRow,
  HabitCheckIn as HabitCheckInRow,
  HabitNote as HabitNoteRow,
  HabitOccurrence as HabitOccurrenceRow,
  HabitPause as HabitPauseRow,
  HabitScheduleChange as HabitScheduleChangeRow,
  HabitScheduleVersion as HabitScheduleVersionRow,
} from '../../generated/prisma/client.js';

/**
 * Conversions between the habit tables and the shared contracts (P3-01, ADR-0028). Calendar days
 * are PostgreSQL `date` columns, which Prisma hands over as a `Date` at UTC midnight; the API
 * speaks ISO `YYYY-MM-DD` strings only, so these two helpers are the single place that converts —
 * never `new Date(localDate)` elsewhere, never a time-zone conversion of a local date.
 */
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `'2026-11-28'` → the `Date` Prisma writes to a `date` column as that same day. */
export function toDbDate(localDate: string): Date {
  if (!LOCAL_DATE.test(localDate)) throw new RangeError('Expected a YYYY-MM-DD local date');
  const date = new Date(`${localDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== localDate) {
    throw new RangeError('Not a real calendar date');
  }
  return date;
}

/** A `date` column value (UTC midnight) → `'YYYY-MM-DD'`. */
export function fromDbDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const fromDbDateOrNull = (date: Date | null): string | null => (date ? fromDbDate(date) : null);
const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);
/** `numeric(12,3)` → number. Exact: values are ≤ 1,000,000 with ≤ 3 decimals (CHECK). */
const toNumber = (value: Prisma.Decimal): number => value.toNumber();

/** The schedule columns of `habit_schedule_versions` for one rule (all kinds' columns set). */
export interface ScheduleColumns {
  kind: HabitScheduleRule['kind'];
  daysOfWeek: number[];
  daysOfMonth: number[];
  intervalDays: number | null;
  anchorDate: Date | null;
  period: 'week' | 'month' | null;
  timesPerPeriod: number | null;
}

/** Rule → columns; the columns another kind uses are empty/null (`…_rule_check`). */
export function scheduleColumns(rule: HabitScheduleRule): ScheduleColumns {
  const columns: ScheduleColumns = {
    kind: rule.kind,
    daysOfWeek: [],
    daysOfMonth: [],
    intervalDays: null,
    anchorDate: null,
    period: null,
    timesPerPeriod: null,
  };
  switch (rule.kind) {
    case 'daily':
      break;
    case 'weekdays':
      columns.daysOfWeek = [...rule.daysOfWeek];
      break;
    case 'monthly_days':
      columns.daysOfMonth = [...rule.daysOfMonth];
      break;
    case 'interval':
      columns.intervalDays = rule.intervalDays;
      columns.anchorDate = toDbDate(rule.anchorDate);
      break;
    case 'times_per_period':
      columns.period = rule.period;
      columns.timesPerPeriod = rule.timesPerPeriod;
      break;
  }
  return columns;
}

/** Columns → rule. Throws if a row breaks the shape the database CHECK guarantees. */
export function scheduleRuleFromColumns(
  row: Pick<
    HabitScheduleVersionRow,
    | 'kind'
    | 'daysOfWeek'
    | 'daysOfMonth'
    | 'intervalDays'
    | 'anchorDate'
    | 'period'
    | 'timesPerPeriod'
  >,
): HabitScheduleRule {
  switch (row.kind) {
    case 'daily':
      return { kind: 'daily' };
    case 'weekdays':
      return { kind: 'weekdays', daysOfWeek: [...row.daysOfWeek] };
    case 'monthly_days':
      return { kind: 'monthly_days', daysOfMonth: [...row.daysOfMonth] };
    case 'interval':
      if (row.intervalDays === null || row.anchorDate === null) break;
      return {
        kind: 'interval',
        intervalDays: row.intervalDays,
        anchorDate: fromDbDate(row.anchorDate),
      };
    case 'times_per_period':
      if (row.period === null || row.timesPerPeriod === null) break;
      return { kind: 'times_per_period', period: row.period, timesPerPeriod: row.timesPerPeriod };
  }
  throw new Error(`Schedule version row does not match its kind "${row.kind}"`);
}

/**
 * The rule columns of a version: schedule, target, grace days, and the calendar settings its
 * periods are counted in (snapshotted from the user's preferences when written, ADR-0030).
 */
export function versionRuleColumns(
  rules: HabitRules,
  settings: { weekStart: HabitWeekStart; calendar: HabitCalendar },
) {
  return {
    ...scheduleColumns(rules.schedule),
    graceDays: rules.graceDays,
    targetValue: rules.target ? new Prisma.Decimal(rules.target.value) : null,
    targetComparison: rules.target?.comparison ?? null,
    weekStart: settings.weekStart,
    calendar: settings.calendar,
  };
}

function targetFromRow(row: Pick<HabitScheduleVersionRow, 'targetValue' | 'targetComparison'>) {
  if (row.targetValue === null || row.targetComparison === null) return null;
  const target: HabitTarget = {
    comparison: row.targetComparison,
    value: toNumber(row.targetValue),
  };
  return target;
}

export function toScheduleVersion(row: HabitScheduleVersionRow): HabitScheduleVersion {
  return {
    id: row.id,
    effectiveFrom: fromDbDate(row.effectiveFrom),
    effectiveTo: fromDbDateOrNull(row.effectiveTo),
    schedule: scheduleRuleFromColumns(row),
    target: targetFromRow(row),
    graceDays: row.graceDays,
    weekStart: row.weekStart,
    calendar: row.calendar,
    createdAt: iso(row.createdAt),
  };
}

/** An audit row → contract. Snapshots are stored as written by the service (contract shape). */
export function toScheduleChange(row: HabitScheduleChangeRow): HabitScheduleChange {
  return {
    id: row.id,
    habitId: row.habitId,
    versionId: row.versionId,
    operation: row.operation,
    effectiveFrom: fromDbDate(row.effectiveFrom),
    localToday: fromDbDate(row.localToday),
    isCorrection: row.isCorrection,
    reason: row.reason,
    affectedRecordedDays: row.affectedRecordedDays,
    before: row.before === null ? null : (row.before as unknown as HabitScheduleVersionSnapshot[]),
    after: row.after as unknown as HabitScheduleVersionSnapshot[],
    createdAt: iso(row.createdAt),
  };
}

export function toHabit(row: HabitRow): Habit {
  return {
    id: row.id,
    categoryId: row.categoryId,
    type: row.type,
    name: row.name,
    description: row.description,
    unit: row.unit,
    icon: row.icon,
    color: row.color,
    startsOn: fromDbDate(row.startsOn),
    endsOn: fromDbDateOrNull(row.endsOn),
    preferredTime:
      row.preferredTimeMinutes === null ? null : minutesToPreferredTime(row.preferredTimeMinutes),
    position: row.position,
    version: row.version,
    archivedAt: isoOrNull(row.archivedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toHabitCategory(row: HabitCategoryRow): HabitCategory {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    position: row.position,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toOccurrenceRecord(row: HabitOccurrenceRow): HabitOccurrenceRecord {
  return {
    habitId: row.habitId,
    localDate: fromDbDate(row.localDate),
    value: row.value === null ? null : toNumber(row.value),
    skipped: row.skipped,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toHabitNote(row: HabitNoteRow): HabitNote {
  return {
    id: row.id,
    habitId: row.habitId,
    localDate: fromDbDateOrNull(row.localDate),
    body: row.body,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toHabitPause(row: HabitPauseRow): HabitPause {
  return {
    id: row.id,
    habitId: row.habitId,
    startsOn: fromDbDate(row.startsOn),
    endsOn: fromDbDateOrNull(row.endsOn),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toHabitCheckIn(row: HabitCheckInRow): HabitCheckIn {
  return {
    id: row.id,
    habitId: row.habitId,
    operationId: row.operationId,
    localDate: fromDbDate(row.localDate),
    action: row.action,
    value: row.value === null ? null : toNumber(row.value),
    changed: row.changed,
    occurrenceVersion: row.occurrenceVersion,
    localToday: fromDbDate(row.localToday),
    createdAt: iso(row.createdAt),
  };
}
