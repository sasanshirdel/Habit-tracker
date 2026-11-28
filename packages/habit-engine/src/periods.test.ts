import { describe, expect, it } from 'vitest';
import { formatLocalDate, parseLocalDate } from './dates.js';
import { ScheduleInputError } from './errors.js';
import { monthOf, monthPositionOf, periodContaining, weekOf } from './periods.js';

const week = (iso: string, weekStart: 'saturday' | 'sunday' | 'monday') => {
  const r = weekOf(parseLocalDate(iso), weekStart);
  return [formatLocalDate(r.start), formatLocalDate(r.end)];
};

describe('weeks by week start', () => {
  // 2026-11-28 is a Saturday.
  it.each([
    ['2026-11-28', 'saturday', '2026-11-28', '2026-12-04'],
    ['2026-12-04', 'saturday', '2026-11-28', '2026-12-04'], // Friday ends a Persian week
    ['2026-11-27', 'saturday', '2026-11-21', '2026-11-27'],
    ['2026-11-28', 'sunday', '2026-11-22', '2026-11-28'],
    ['2026-11-29', 'sunday', '2026-11-29', '2026-12-05'],
    ['2026-11-28', 'monday', '2026-11-23', '2026-11-29'],
    ['2026-11-30', 'monday', '2026-11-30', '2026-12-06'],
    ['2026-12-31', 'monday', '2026-12-28', '2027-01-03'], // across a year end
    ['2024-02-29', 'saturday', '2024-02-24', '2024-03-01'], // across a leap day
  ] as const)('%s with %s weeks: %s..%s', (iso, weekStart, start, end) => {
    expect(week(iso, weekStart)).toEqual([start, end]);
  });

  it('always contains the day, has 7 days and starts on the week start', () => {
    const startIso = { monday: 1, saturday: 6, sunday: 7 } as const;
    for (let d = parseLocalDate('2026-01-01'); d < parseLocalDate('2026-02-01'); d += 1) {
      for (const ws of ['saturday', 'sunday', 'monday'] as const) {
        const r = weekOf(d, ws);
        expect(r.start <= d && d <= r.end).toBe(true);
        expect(r.end - r.start).toBe(6);
        expect(((r.start + 3) % 7) + 1).toBe(startIso[ws]);
      }
    }
  });
});

describe('months by calendar', () => {
  it.each([
    ['2026-11-28', 'gregorian', '2026-11-01', '2026-11-30'],
    ['2024-02-10', 'gregorian', '2024-02-01', '2024-02-29'],
    ['2026-02-10', 'gregorian', '2026-02-01', '2026-02-28'],
    ['2100-02-10', 'gregorian', '2100-02-01', '2100-02-28'],
    ['2026-11-28', 'solar_hijri', '2026-11-22', '2026-12-21'], // Azar 1405
    ['2026-03-21', 'solar_hijri', '2026-03-21', '2026-04-20'], // Farvardin 1405
    ['2025-03-10', 'solar_hijri', '2025-02-19', '2025-03-20'], // Esfand 1403 (leap, 30 days)
    ['2026-03-10', 'solar_hijri', '2026-02-20', '2026-03-20'], // Esfand 1404 (29 days)
  ] as const)('%s in %s: %s..%s', (iso, calendar, start, end) => {
    expect(periodContaining(iso, 'month', { weekStart: 'monday', calendar })).toEqual({
      start,
      end,
    });
  });

  it('positions days within their month', () => {
    expect(monthPositionOf(parseLocalDate('2025-03-20'), 'solar_hijri')).toEqual({
      dayOfMonth: 30,
      monthLength: 30,
    });
    expect(monthPositionOf(parseLocalDate('2024-02-29'), 'gregorian')).toEqual({
      dayOfMonth: 29,
      monthLength: 29,
    });
  });

  it('tiles the window without gaps in both calendars', () => {
    for (const calendar of ['gregorian', 'solar_hijri'] as const) {
      let d = parseLocalDate('2000-01-01');
      const end = parseLocalDate('2099-12-31');
      let months = 0;
      while (d <= end) {
        const m = monthOf(d, calendar);
        expect(m.start).toBe(d === parseLocalDate('2000-01-01') ? m.start : d);
        d = m.end + 1;
        months += 1;
      }
      expect(months).toBeGreaterThanOrEqual(1200);
    }
  });
});

describe('periodContaining', () => {
  it('returns the week as local dates', () => {
    expect(
      periodContaining('2026-11-28', 'week', { weekStart: 'saturday', calendar: 'solar_hijri' }),
    ).toEqual({
      start: '2026-11-28',
      end: '2026-12-04',
    });
  });

  it.each([
    ['2026-11-28', 'fortnight', 'monday', 'gregorian'],
    ['2026-11-28', 'week', 'friday', 'gregorian'],
    ['2026-11-28', 'week', 'monday', 'julian'],
    ['2026-02-30', 'week', 'monday', 'gregorian'],
  ])('refuses %s %s %s %s', (date, period, weekStart, calendar) => {
    expect(() =>
      periodContaining(date, period as 'week', {
        weekStart: weekStart as 'monday',
        calendar: calendar as 'gregorian',
      }),
    ).toThrow(ScheduleInputError);
  });
});
