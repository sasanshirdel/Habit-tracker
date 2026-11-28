import { describe, expect, it } from 'vitest';
import { ENGINE_DATE_MAX, ENGINE_DATE_MIN, formatLocalDate, parseLocalDate } from './dates.js';
import { ScheduleInputError } from './errors.js';
import {
  dayToSolarHijri,
  isSolarHijriLeapYear,
  SOLAR_HIJRI_YEAR_MAX,
  SOLAR_HIJRI_YEAR_MIN,
  solarHijriMonthLength,
  solarHijriToDay,
} from './solar-hijri.js';

const fromIso = (iso: string) => dayToSolarHijri(parseLocalDate(iso));
const toIso = (y: number, m: number, d: number) => formatLocalDate(solarHijriToDay(y, m, d));

describe('known dates (official Iranian calendar)', () => {
  it.each([
    // Nowruz (1 Farvardin)
    ['2000-03-20', 1379, 1, 1],
    ['2017-03-21', 1396, 1, 1],
    ['2020-03-20', 1399, 1, 1],
    ['2021-03-21', 1400, 1, 1],
    ['2024-03-20', 1403, 1, 1],
    ['2025-03-21', 1404, 1, 1],
    ['2026-03-21', 1405, 1, 1],
    ['2029-03-20', 1408, 1, 1],
    // 30 Esfand of leap years
    ['2021-03-20', 1399, 12, 30],
    ['2025-03-20', 1403, 12, 30],
    ['2030-03-20', 1408, 12, 30],
    // 29 Esfand of common years
    ['2026-03-20', 1404, 12, 29],
    ['2024-03-19', 1402, 12, 29],
    // Other landmarks
    ['1979-02-11', 1357, 11, 22],
    ['2026-11-28', 1405, 9, 7],
    ['2000-01-01', 1378, 10, 11],
    ['2099-12-31', 1478, 10, 11],
    ['2026-09-22', 1405, 6, 31], // last day of the 31-day half
    ['2026-09-23', 1405, 7, 1],
  ])('%s = %i-%i-%i', (iso, year, month, day) => {
    expect(fromIso(iso)).toEqual({ year, month, day });
    expect(toIso(year, month, day)).toBe(iso);
  });
});

describe('agreement with Intl (ICU) persian calendar', () => {
  const intl = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const viaIntl = (day: number) => {
    const parts = intl.formatToParts(day * 86_400_000);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return { year: get('year'), month: get('month'), day: get('day') };
  };

  it('matches every day of the engine window 2000-01-01..2099-12-31 and round-trips', () => {
    const first = parseLocalDate(ENGINE_DATE_MIN);
    const last = parseLocalDate(ENGINE_DATE_MAX);
    const mismatches: string[] = [];
    for (let d = first; d <= last; d += 1) {
      const s = dayToSolarHijri(d);
      const i = viaIntl(d);
      if (s.year !== i.year || s.month !== i.month || s.day !== i.day) {
        mismatches.push(formatLocalDate(d));
      }
      if (solarHijriToDay(s.year, s.month, s.day) !== d) mismatches.push(`round-trip ${d}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('documents where ICU diverges: from 1503 AP (2124) ICU uses its own leap rule', () => {
    // Outside the engine window; the engine keeps Borkowski's astronomical-based rule.
    const d = parseLocalDate('2124-03-20');
    expect(dayToSolarHijri(d)).toEqual({ year: 1502, month: 12, day: 30 });
    expect(viaIntl(d)).toEqual({ year: 1503, month: 1, day: 1 });
  });
});

describe('leap years and month lengths', () => {
  it('has the leap years of 1370..1480 that ICU and the official calendar agree on', () => {
    const leaps: number[] = [];
    for (let y = 1370; y <= 1480; y += 1) if (isSolarHijriLeapYear(y)) leaps.push(y);
    expect(leaps).toEqual([
      1370, 1375, 1379, 1383, 1387, 1391, 1395, 1399, 1403, 1408, 1412, 1416, 1420, 1424, 1428,
      1432, 1436, 1441, 1445, 1449, 1453, 1457, 1461, 1465, 1469, 1474, 1478,
    ]);
  });

  it('has 31-day first half, 30-day months 7..11 and a 29/30-day Esfand', () => {
    for (const year of [1403, 1404]) {
      const lengths = Array.from({ length: 12 }, (_, i) => solarHijriMonthLength(year, i + 1));
      expect(lengths.slice(0, 11)).toEqual([31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30]);
      expect(lengths[11]).toBe(year === 1403 ? 30 : 29);
      const total = lengths.reduce((a, b) => a + b, 0);
      expect(solarHijriToDay(year + 1, 1, 1) - solarHijriToDay(year, 1, 1)).toBe(total);
    }
  });

  it("tiles every supported year: each Nowruz follows the previous year's last day", () => {
    // Covers every leap-cycle break, including the rare extra leap day after a 4-year jump
    // (e.g. 5 AP and 752 AP).
    for (let y = SOLAR_HIJRI_YEAR_MIN; y < SOLAR_HIJRI_YEAR_MAX; y += 1) {
      const length = solarHijriToDay(y + 1, 1, 1) - solarHijriToDay(y, 1, 1);
      expect(length).toBe(isSolarHijriLeapYear(y) ? 366 : 365);
    }
  });

  it('works at the ends of the supported years', () => {
    expect(dayToSolarHijri(solarHijriToDay(SOLAR_HIJRI_YEAR_MIN, 1, 1))).toEqual({
      year: 1,
      month: 1,
      day: 1,
    });
    const lastMonth = solarHijriMonthLength(SOLAR_HIJRI_YEAR_MAX, 12);
    const last = solarHijriToDay(SOLAR_HIJRI_YEAR_MAX, 12, lastMonth);
    expect(dayToSolarHijri(last)).toEqual({
      year: SOLAR_HIJRI_YEAR_MAX,
      month: 12,
      day: lastMonth,
    });
    // 1 Farvardin 1 AP = 622-03-22 (proleptic Gregorian), the calendar's epoch.
    expect(toIso(1, 1, 1)).toBe('0622-03-22');
  });
});

describe('invalid input', () => {
  it.each([
    [1404, 12, 30], // not a leap year
    [1403, 7, 31],
    [1403, 13, 1],
    [1403, 0, 1],
    [1403, 1, 0],
    [1403, 1, 1.5],
    [0, 1, 1],
    [3178, 1, 1],
    [1403.5, 1, 1],
  ])('refuses %i-%i-%i', (y, m, d) => {
    expect(() => solarHijriToDay(y, m, d)).toThrow(ScheduleInputError);
  });

  it('refuses a day before year 1 or after year 3177', () => {
    expect(() => dayToSolarHijri(parseLocalDate('0622-03-21'))).toThrow(ScheduleInputError);
    const afterLast =
      solarHijriToDay(SOLAR_HIJRI_YEAR_MAX, 12, solarHijriMonthLength(SOLAR_HIJRI_YEAR_MAX, 12)) +
      1;
    expect(() => dayToSolarHijri(afterLast)).toThrow(ScheduleInputError);
  });
});
