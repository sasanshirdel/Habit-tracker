import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayToGregorian,
  daysBetween,
  formatLocalDate,
  gregorianMonthLength,
  gregorianToDay,
  isGregorianLeapYear,
  isLocalDate,
  isoWeekday,
  isoWeekdayOf,
  mod,
  parseLocalDate,
} from './dates.js';
import { ScheduleInputError } from './errors.js';

/** Reference: the same dates through `Date` at UTC midnight (fine in tests, banned in the engine). */
const viaDate = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

describe('day numbers', () => {
  it.each([
    ['1970-01-01', 0],
    ['1969-12-31', -1],
    ['2000-01-01', 10_957],
    ['2000-02-29', 11_016],
    ['2099-12-31', 47_481],
    ['0001-01-01', -719_162],
    ['9999-12-31', 2_932_896],
  ])('%s is day %i', (iso, day) => {
    expect(parseLocalDate(iso)).toBe(day);
    expect(formatLocalDate(day)).toBe(iso);
    expect(viaDate(iso)).toBe(day);
  });

  it('round-trips and matches Date for every day 1900-01-01..2200-12-31', () => {
    const first = parseLocalDate('1900-01-01');
    const last = parseLocalDate('2200-12-31');
    let previous = dayToGregorian(first - 1);
    for (let d = first; d <= last; d += 1) {
      const g = dayToGregorian(d);
      expect(gregorianToDay(g.year, g.month, g.day)).toBe(d);
      // Consecutive: next day of month, or day 1 of the next month/year.
      if (g.day === 1) {
        expect(previous.day).toBe(gregorianMonthLength(previous.year, previous.month));
      } else {
        expect(g.day).toBe(previous.day + 1);
      }
      previous = g;
    }
    const iso = formatLocalDate(last);
    expect(viaDate(iso)).toBe(last);
  });

  it('agrees with Date on sampled days (UTC midnight)', () => {
    for (let d = -700_000; d <= 2_932_896; d += 9_973) {
      const iso = formatLocalDate(d);
      expect(viaDate(iso)).toBe(d);
    }
  });
});

describe('leap years and month lengths', () => {
  it.each([
    [2000, true],
    [2024, true],
    [2028, true],
    [1900, false],
    [2100, false],
    [2026, false],
    [2400, true],
  ])('%i leap = %s', (year, leap) => {
    expect(isGregorianLeapYear(year)).toBe(leap);
    expect(gregorianMonthLength(year, 2)).toBe(leap ? 29 : 28);
  });

  it('has the usual month lengths', () => {
    expect([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => gregorianMonthLength(2026, m))).toEqual([
      31, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
  });
});

describe('isLocalDate / parseLocalDate', () => {
  it.each(['2026-11-28', '2024-02-29', '2000-02-29', '0001-01-01', '9999-12-31'])(
    'accepts %s',
    (v) => {
      expect(isLocalDate(v)).toBe(true);
    },
  );

  it.each([
    '2026-02-29',
    '1900-02-29',
    '2100-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '0000-01-01',
    '2026-1-5',
    '26-01-05',
    '2026-01-05T00:00:00Z',
    ' 2026-01-05',
    '',
    '۲۰۲۶-۰۱-۰۵',
  ])('rejects %j', (v) => {
    expect(isLocalDate(v)).toBe(false);
    expect(() => parseLocalDate(v)).toThrow(ScheduleInputError);
  });

  it.each([null, undefined, 20260105, new Date(0), {}])('rejects non-strings (%j)', (v) => {
    expect(isLocalDate(v)).toBe(false);
    expect(() => parseLocalDate(v as unknown as string, 'startsOn')).toThrow(/startsOn/);
  });

  it('reports the code INVALID_DATE', () => {
    try {
      parseLocalDate('2026-02-30');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleInputError);
      expect((error as ScheduleInputError).code).toBe('INVALID_DATE');
      expect((error as ScheduleInputError).name).toBe('ScheduleInputError');
    }
  });
});

describe('weekdays', () => {
  it.each([
    ['1970-01-01', 4],
    ['2026-11-28', 6], // Saturday
    ['2026-11-29', 7], // Sunday
    ['2026-11-30', 1], // Monday
    ['2000-01-01', 6],
    ['2024-02-29', 4],
    ['1969-12-28', 7],
  ])('%s is ISO weekday %i', (iso, weekday) => {
    expect(isoWeekday(iso)).toBe(weekday);
  });

  it('cycles 1..7 for negative and positive day numbers', () => {
    for (let d = -20; d <= 20; d += 1) {
      expect(isoWeekdayOf(d + 7)).toBe(isoWeekdayOf(d));
      expect(isoWeekdayOf(d + 1)).toBe((isoWeekdayOf(d) % 7) + 1);
    }
  });
});

describe('addDays / daysBetween / mod', () => {
  it.each([
    ['2026-11-28', 1, '2026-11-29'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2024-02-28', 1, '2024-02-29'],
    ['2023-02-28', 1, '2023-03-01'],
    ['2024-03-01', -1, '2024-02-29'],
    ['2026-03-08', 0, '2026-03-08'], // US DST day: still a whole day
    ['2000-01-01', 36_524, '2099-12-31'],
  ])('%s + %i = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
    expect(daysBetween(date, expected)).toBe(days);
  });

  it('refuses fractional day counts', () => {
    expect(() => addDays('2026-01-01', 0.5)).toThrow(ScheduleInputError);
  });

  it('floors modulo for negatives', () => {
    expect(mod(-1, 7)).toBe(6);
    expect(mod(-7, 7)).toBe(0);
    expect(mod(15, 7)).toBe(1);
  });
});
