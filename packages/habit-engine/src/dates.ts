/**
 * Local calendar dates as plain numbers (ADR-0029).
 *
 * A local date is an ISO 8601 Gregorian `YYYY-MM-DD` string without time or zone (ADR-0028).
 * Inside the engine it is a **day number**: whole days since 1970-01-01 (day 0). Day numbers are
 * integers, so adding days, comparing and taking weekdays is exact integer arithmetic — no `Date`,
 * no time zone, no daylight-saving time anywhere in the engine. Conversions use Howard Hinnant's
 * `days_from_civil` / `civil_from_days` algorithms (proleptic Gregorian calendar).
 */
import { ScheduleInputError } from './errors.js';

/** Whole days since 1970-01-01 (negative before). */
export type DayNumber = number;

/** First and last local date the engine computes schedules for (= `HABIT_DATE_MIN`/`MAX`). */
export const ENGINE_DATE_MIN = '2000-01-01';
export const ENGINE_DATE_MAX = '2099-12-31';

export interface GregorianDate {
  year: number;
  /** 1..12 */
  month: number;
  /** 1..31 */
  day: number;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Days in a Gregorian month (28..31). */
export function gregorianMonthLength(year: number, month: number): number {
  if (month === 2 && isGregorianLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] as number;
}

/** Day number of a Gregorian date (no validation; see {@link parseLocalDate}). */
export function gregorianToDay(year: number, month: number, day: number): DayNumber {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = (month + 9) % 12; // March = 0 … February = 11
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146_097 + doe - 719_468;
}

/** Gregorian date of a day number. */
export function dayToGregorian(dayNumber: DayNumber): GregorianDate {
  const z = dayNumber + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/** True for a real Gregorian date in `YYYY-MM-DD` form (years 0001..9999). */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = LOCAL_DATE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return (
    year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= gregorianMonthLength(year, month)
  );
}

/**
 * Day number of a local date. Throws {@link ScheduleInputError} `INVALID_DATE` for anything that
 * is not a real `YYYY-MM-DD` date (`2026-02-29`, `2026-1-5`, a `Date`, …).
 */
export function parseLocalDate(value: string, what = 'date'): DayNumber {
  if (!isLocalDate(value)) {
    throw new ScheduleInputError('INVALID_DATE', `${what} must be a real YYYY-MM-DD date`);
  }
  return gregorianToDay(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)),
    Number(value.slice(8, 10)),
  );
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** `YYYY-MM-DD` of a day number (years 0001..9999). */
export function formatLocalDate(dayNumber: DayNumber): string {
  const { year, month, day } = dayToGregorian(dayNumber);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** ISO weekday of a day number: 1 = Monday … 7 = Sunday (1970-01-01 was a Thursday). */
export function isoWeekdayOf(dayNumber: DayNumber): number {
  return ((((dayNumber + 3) % 7) + 7) % 7) + 1;
}

/** ISO weekday of a local date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  return isoWeekdayOf(parseLocalDate(date));
}

/** The local date `days` days after (negative: before) `date`. */
export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days))
    throw new ScheduleInputError('INVALID_RANGE', 'days must be an integer');
  return formatLocalDate(parseLocalDate(date) + days);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return parseLocalDate(to, 'to') - parseLocalDate(from, 'from');
}

/** Floor modulo: always in [0, n). */
export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
