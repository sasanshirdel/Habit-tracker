import { z } from 'zod';

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isRealGregorianDate(value: string): boolean {
  const m = LOCAL_DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  return day <= daysInMonth;
}

/**
 * A calendar date without time or zone, `YYYY-MM-DD` (ISO 8601, Gregorian). Habit occurrences
 * are keyed by the user's local date (ADR-0006); Solar Hijri is a display concern, never stored.
 */
export const localDateSchema = z.string().refine(isRealGregorianDate, {
  message: 'Must be a real calendar date in YYYY-MM-DD format',
});
