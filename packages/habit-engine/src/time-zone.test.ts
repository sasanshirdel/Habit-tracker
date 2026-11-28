import { describe, expect, it } from 'vitest';
import { ScheduleInputError } from './errors.js';
import { isTimeZone, localDateAt } from './time-zone.js';

describe('localDateAt — "today" from an instant and an IANA zone', () => {
  it.each([
    // Asia/Tehran: UTC+03:30 all year since 2022 (DST abolished).
    ['2026-11-27T20:29:59.999Z', 'Asia/Tehran', '2026-11-27'],
    ['2026-11-27T20:30:00.000Z', 'Asia/Tehran', '2026-11-28'],
    ['2026-06-15T20:29:59Z', 'Asia/Tehran', '2026-06-15'],
    ['2026-06-15T20:30:00Z', 'Asia/Tehran', '2026-06-16'],
    // Asia/Tehran while it still had DST (UTC+04:30 in summer 2021).
    ['2021-06-01T19:29:59Z', 'Asia/Tehran', '2021-06-01'],
    ['2021-06-01T19:30:00Z', 'Asia/Tehran', '2021-06-02'],
    ['2021-12-01T20:29:59Z', 'Asia/Tehran', '2021-12-01'],
    // New York, around the spring-forward and fall-back transitions.
    ['2026-03-08T04:59:59Z', 'America/New_York', '2026-03-07'], // 23:59:59 EST
    ['2026-03-08T05:00:00Z', 'America/New_York', '2026-03-08'], // 00:00 EST
    ['2026-03-08T07:00:00Z', 'America/New_York', '2026-03-08'], // 03:00 EDT (02:00 skipped)
    ['2026-03-09T03:59:59Z', 'America/New_York', '2026-03-08'], // 23:59:59 EDT
    ['2026-03-09T04:00:00Z', 'America/New_York', '2026-03-09'],
    ['2026-11-01T05:30:00Z', 'America/New_York', '2026-11-01'], // 01:30 EDT
    ['2026-11-01T06:30:00Z', 'America/New_York', '2026-11-01'], // 01:30 EST (repeated hour)
    ['2026-11-02T04:59:59Z', 'America/New_York', '2026-11-01'], // 23:59:59 EST
    // Los Angeles, São Paulo (no DST since 2019), Newfoundland (half hour).
    ['2026-07-01T06:59:59Z', 'America/Los_Angeles', '2026-06-30'],
    ['2026-07-01T07:00:00Z', 'America/Los_Angeles', '2026-07-01'],
    ['2026-01-01T02:59:59Z', 'America/Sao_Paulo', '2025-12-31'],
    ['2026-01-01T03:30:00Z', 'America/St_Johns', '2026-01-01'],
    ['2026-01-01T03:29:59Z', 'America/St_Johns', '2025-12-31'],
    // Extremes and odd offsets.
    ['2025-12-31T09:59:59Z', 'Pacific/Kiritimati', '2025-12-31'], // UTC+14
    ['2025-12-31T10:00:00Z', 'Pacific/Kiritimati', '2026-01-01'],
    ['2026-01-01T10:59:59Z', 'Pacific/Pago_Pago', '2025-12-31'], // UTC-11
    ['2025-12-31T18:14:59Z', 'Asia/Kathmandu', '2025-12-31'], // UTC+05:45
    ['2025-12-31T18:15:00Z', 'Asia/Kathmandu', '2026-01-01'],
    ['2026-01-01T00:00:00Z', 'UTC', '2026-01-01'],
    ['2026-01-01T00:00:00+03:30', 'Asia/Tehran', '2026-01-01'],
    // Samoa skipped 2011-12-30 entirely (moved across the date line).
    ['2011-12-30T09:59:59Z', 'Pacific/Apia', '2011-12-29'],
    ['2011-12-30T10:00:00Z', 'Pacific/Apia', '2011-12-31'],
  ])('%j in %s is %s', (instant, zone, expected) => {
    expect(localDateAt(instant, zone)).toBe(expected);
  });

  it('accepts a Date and epoch milliseconds', () => {
    const instant = Date.parse('2026-11-27T21:00:00Z');
    expect(localDateAt(new Date(instant), 'Asia/Tehran')).toBe('2026-11-28');
    expect(localDateAt(instant, 'America/New_York')).toBe('2026-11-27');
  });

  it('gives the same instant different dates in different zones (a user who travels)', () => {
    const instant = '2026-11-28T02:00:00Z';
    expect(localDateAt(instant, 'Asia/Tehran')).toBe('2026-11-28');
    expect(localDateAt(instant, 'America/Los_Angeles')).toBe('2026-11-27');
  });

  it.each([
    ['2026-11-28T00:00:00', 'zone-less strings would depend on the server zone'],
    ['2026-11-28', 'a date is not an instant'],
    ['not a date', 'garbage'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [new Date('invalid'), 'invalid Date'],
    [null, 'null'],
  ] as [unknown, string][])('refuses %j (%s)', (instant) => {
    expect(() => localDateAt(instant as unknown as string, 'UTC')).toThrow(ScheduleInputError);
  });

  it.each(['Mars/Olympus', '', 'Asia/Tehran ', '+03:30x'])('refuses the zone %j', (zone) => {
    expect(isTimeZone(zone)).toBe(false);
    try {
      localDateAt(0, zone);
      expect.unreachable();
    } catch (error) {
      expect((error as ScheduleInputError).code).toBe('INVALID_TIME_ZONE');
    }
  });

  it('keeps working when more zones are used than the formatter cache holds', () => {
    const zones = Intl.supportedValuesOf('timeZone');
    expect(zones.length).toBeGreaterThan(64);
    for (const zone of zones) expect(localDateAt(0, zone)).toMatch(/^19(69|70)-(12|01)-(31|01)$/);
    expect(localDateAt(0, 'Asia/Tehran')).toBe('1970-01-01');
  });
});
