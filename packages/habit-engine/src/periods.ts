/**
 * Calendar periods (weeks and months) on day numbers (ADR-0029).
 *
 * - A **week** is the 7 days starting on the week start (`saturday` | `sunday` | `monday`,
 *   ADR-0024). Weekdays themselves are always ISO numbers (1 = Monday … 7 = Sunday).
 * - A **month** is a Gregorian month or a Solar Hijri month, by calendar system.
 */
import type { CalendarSystem, WeekStart } from '@habit/localization';
import {
  dayToGregorian,
  formatLocalDate,
  gregorianMonthLength,
  gregorianToDay,
  isoWeekdayOf,
  mod,
  parseLocalDate,
  type DayNumber,
} from './dates.js';
import { ScheduleInputError } from './errors.js';
import { dayToSolarHijri, solarHijriMonthLength, solarHijriToDay } from './solar-hijri.js';

export type PeriodKind = 'week' | 'month';

/** A period as an inclusive range of day numbers. */
export interface DayRange {
  start: DayNumber;
  end: DayNumber;
}

const WEEK_START_ISO: Record<WeekStart, number> = { monday: 1, saturday: 6, sunday: 7 };

export function assertWeekStart(weekStart: unknown): asserts weekStart is WeekStart {
  if (typeof weekStart !== 'string' || !Object.hasOwn(WEEK_START_ISO, weekStart)) {
    throw new ScheduleInputError('INVALID_RULE', 'weekStart must be saturday, sunday or monday');
  }
}

export function assertCalendar(calendar: unknown): asserts calendar is CalendarSystem {
  if (calendar !== 'gregorian' && calendar !== 'solar_hijri') {
    throw new ScheduleInputError('INVALID_RULE', 'calendar must be gregorian or solar_hijri');
  }
}

/** The week (by `weekStart`) containing a day. */
export function weekOf(dayNumber: DayNumber, weekStart: WeekStart): DayRange {
  const start = dayNumber - mod(isoWeekdayOf(dayNumber) - WEEK_START_ISO[weekStart], 7);
  return { start, end: start + 6 };
}

/** A day's position in its month: day of month (1-based) and the month's length. */
export interface MonthPosition {
  dayOfMonth: number;
  monthLength: number;
}

/** Day of month and month length of a day in a calendar system. */
export function monthPositionOf(dayNumber: DayNumber, calendar: CalendarSystem): MonthPosition {
  if (calendar === 'gregorian') {
    const g = dayToGregorian(dayNumber);
    return { dayOfMonth: g.day, monthLength: gregorianMonthLength(g.year, g.month) };
  }
  const s = dayToSolarHijri(dayNumber);
  return { dayOfMonth: s.day, monthLength: solarHijriMonthLength(s.year, s.month) };
}

/** The month (Gregorian or Solar Hijri) containing a day. */
export function monthOf(dayNumber: DayNumber, calendar: CalendarSystem): DayRange {
  if (calendar === 'gregorian') {
    const g = dayToGregorian(dayNumber);
    const start = gregorianToDay(g.year, g.month, 1);
    return { start, end: start + gregorianMonthLength(g.year, g.month) - 1 };
  }
  const s = dayToSolarHijri(dayNumber);
  const start = solarHijriToDay(s.year, s.month, 1);
  return { start, end: start + solarHijriMonthLength(s.year, s.month) - 1 };
}

export interface PeriodOptions {
  weekStart: WeekStart;
  calendar: CalendarSystem;
}

/** The period of a kind containing a day number. */
export function periodOfDay(
  dayNumber: DayNumber,
  period: PeriodKind,
  options: PeriodOptions,
): DayRange {
  return period === 'week'
    ? weekOf(dayNumber, options.weekStart)
    : monthOf(dayNumber, options.calendar);
}

/**
 * The week or month containing `date`, as inclusive local dates — e.g. the columns of the weekly
 * matrix (`periodContaining(today, 'week', { weekStart, calendar })`).
 */
export function periodContaining(
  date: string,
  period: PeriodKind,
  options: PeriodOptions,
): { start: string; end: string } {
  if (period !== 'week' && period !== 'month') {
    throw new ScheduleInputError('INVALID_RULE', 'period must be week or month');
  }
  assertWeekStart(options.weekStart);
  assertCalendar(options.calendar);
  const range = periodOfDay(parseLocalDate(date), period, options);
  return { start: formatLocalDate(range.start), end: formatLocalDate(range.end) };
}
