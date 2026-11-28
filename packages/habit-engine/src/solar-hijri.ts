/**
 * Solar Hijri (Iranian, "Jalali", `Intl` `persian`) calendar ↔ Gregorian day numbers (ADR-0029).
 *
 * Month periods and "day N of the month" for users whose calendar is Solar Hijri need the Persian
 * month boundaries, computed the same way on every server, browser and ICU version. `Intl` can
 * only format (and its rules are ICU's, which differ across releases), so the engine computes the
 * calendar itself with the leap-year "breaks" algorithm of Kazimierz M. Borkowski ("The Persian
 * calendar for 3000 years", Earth, Moon and Planets 74, 1996) — the algorithm used by the widely
 * deployed `jalaali-js` — which follows the official astronomical calendar for years 1..3177 AP.
 * A test compares every day of the engine window with Node's `Intl` `persian` calendar.
 *
 * Months 1..6 have 31 days, 7..11 have 30, month 12 (Esfand) has 29, or 30 in a leap year.
 */
import { gregorianToDay, dayToGregorian, type DayNumber } from './dates.js';
import { ScheduleInputError } from './errors.js';

export interface SolarHijriDate {
  year: number;
  /** 1 = Farvardin … 12 = Esfand */
  month: number;
  day: number;
}

/** Years (AP) where the leap cycle changes (Borkowski). Valid years: BREAKS[0]..last - 1. */
const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
  2456, 3178,
] as const;

/** Supported Solar Hijri years. */
export const SOLAR_HIJRI_YEAR_MIN = 1;
export const SOLAR_HIJRI_YEAR_MAX = 3177;

const div = (a: number, b: number) => Math.trunc(a / b);
const rem = (a: number, b: number) => a - Math.trunc(a / b) * b;

interface YearInfo {
  /** Day number of 1 Farvardin. */
  nowruz: DayNumber;
  leap: boolean;
}

function assertYear(year: number): void {
  if (!Number.isInteger(year) || year < SOLAR_HIJRI_YEAR_MIN || year > SOLAR_HIJRI_YEAR_MAX) {
    throw new ScheduleInputError(
      'INVALID_DATE',
      `Solar Hijri year must be an integer ${SOLAR_HIJRI_YEAR_MIN}..${SOLAR_HIJRI_YEAR_MAX}`,
    );
  }
}

/** 1 Farvardin and leapness of a Solar Hijri year (Borkowski's `jalCal`). */
function yearInfo(year: number): YearInfo {
  assertYear(year);
  const gy = year + 621;
  let leapJ = -14;
  let jp: number = BREAKS[0];
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i += 1) {
    const jm = BREAKS[i] as number;
    jump = jm - jp;
    if (year < jm) break;
    leapJ += div(jump, 33) * 8 + div(rem(jump, 33), 4);
    jp = jm;
  }
  let n = year - jp;
  leapJ += div(n, 33) * 8 + div(rem(n, 33) + 3, 4);
  if (rem(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = rem(rem(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { nowruz: gregorianToDay(gy, 3, march), leap: leap === 0 };
}

export function isSolarHijriLeapYear(year: number): boolean {
  return yearInfo(year).leap;
}

/** Days in a Solar Hijri month (29..31). */
export function solarHijriMonthLength(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ScheduleInputError('INVALID_DATE', 'Solar Hijri month must be 1..12');
  }
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  return isSolarHijriLeapYear(year) ? 30 : 29;
}

/** Day offset of the first day of `month` from 1 Farvardin. */
const monthOffset = (month: number) => (month <= 7 ? (month - 1) * 31 : 186 + (month - 7) * 30);

/** Day number of a Solar Hijri date; throws `INVALID_DATE` for a date that does not exist. */
export function solarHijriToDay(year: number, month: number, day: number): DayNumber {
  const length = solarHijriMonthLength(year, month);
  if (!Number.isInteger(day) || day < 1 || day > length) {
    throw new ScheduleInputError('INVALID_DATE', `Solar Hijri day must be 1..${length}`);
  }
  return yearInfo(year).nowruz + monthOffset(month) + day - 1;
}

/** Solar Hijri date of a day number. */
export function dayToSolarHijri(dayNumber: DayNumber): SolarHijriDate {
  // 1 Farvardin falls on 20 or 21 March (or 19..22 far from the present), so the Solar Hijri
  // year is the Gregorian year - 621 from Nowruz on, and one less before it.
  let year = Math.min(dayToGregorian(dayNumber).year - 621, SOLAR_HIJRI_YEAR_MAX);
  let info = yearInfo(year);
  if (dayNumber < info.nowruz) {
    year -= 1;
    info = yearInfo(year);
  }
  const k = dayNumber - info.nowruz; // 0..365
  if (k >= (info.leap ? 366 : 365)) {
    throw new ScheduleInputError(
      'INVALID_DATE',
      `Solar Hijri year must be ..${SOLAR_HIJRI_YEAR_MAX}`,
    );
  }
  if (k < 186) return { year, month: 1 + Math.floor(k / 31), day: (k % 31) + 1 };
  const rest = k - 186;
  return { year, month: 7 + Math.floor(rest / 30), day: (rest % 30) + 1 };
}
