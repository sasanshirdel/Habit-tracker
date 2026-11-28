/**
 * Property tests (ADR-0029): seeded random habits — versions in any order with gaps, every rule
 * kind, both calendars and all week starts, overlapping and open pauses, end and archive dates —
 * checked against invariants that must hold for every input. Seeds are fixed, so runs are
 * reproducible; a failure message names its seed.
 */
import { describe, expect, it } from 'vitest';
import {
  dayToGregorian,
  formatLocalDate,
  gregorianMonthLength,
  isoWeekdayOf,
  mod,
  parseLocalDate,
} from './dates.js';
import { monthPositionOf, periodOfDay } from './periods.js';
import { computeSchedule, type ScheduleInput, type ScheduleVersionInput } from './schedule.js';
import { dayToSolarHijri, solarHijriToDay } from './solar-hijri.js';
import { Gen } from './test-support/random.js';

const RUNS = 400;

function forEachSeed(fn: (gen: Gen) => void): void {
  for (let seed = 1; seed <= RUNS; seed += 1) {
    const gen = new Gen(seed);
    try {
      fn(gen);
    } catch (error) {
      throw new Error(`seed ${seed}: ${(error as Error).message}`, { cause: error });
    }
  }
}

/** The version in effect on a day, by brute force (independent of the engine's binary search). */
function versionOn(input: ScheduleInput, day: number): ScheduleVersionInput | undefined {
  return input.versions.find((v) => {
    const from = parseLocalDate(v.effectiveFrom);
    const to = v.effectiveTo === null ? Infinity : parseLocalDate(v.effectiveTo);
    return from <= day && day < to;
  });
}

const pausedOn = (input: ScheduleInput, day: number) =>
  input.pauses.some(
    (p) =>
      parseLocalDate(p.startsOn) <= day && (p.endsOn === null || day <= parseLocalDate(p.endsOn)),
  );

function activeOn(input: ScheduleInput, day: number): boolean {
  if (day < parseLocalDate(input.startsOn)) return false;
  if (input.endsOn !== null && day > parseLocalDate(input.endsOn)) return false;
  if (input.archivedOn && day >= parseLocalDate(input.archivedOn)) return false;
  return true;
}

/** A naive re-implementation of the rules, day by day. */
function expectedRuleState(v: ScheduleVersionInput, day: number): 'due' | 'off' | 'flexible' {
  const s = v.schedule;
  switch (s.kind) {
    case 'daily':
      return 'due';
    case 'weekdays':
      return s.daysOfWeek.includes(isoWeekdayOf(day)) ? 'due' : 'off';
    case 'monthly_days': {
      let dom: number;
      let last: boolean;
      if (v.calendar === 'gregorian') {
        const g = dayToGregorian(day);
        dom = g.day;
        last = g.day === gregorianMonthLength(g.year, g.month);
      } else {
        const h = dayToSolarHijri(day);
        dom = h.day;
        // Last day ⇔ the next day is the 1st.
        last = dayToSolarHijri(day + 1).day === 1;
      }
      return s.daysOfMonth.includes(dom) || (last && s.daysOfMonth.includes(-1)) ? 'due' : 'off';
    }
    case 'interval':
      return mod(day - parseLocalDate(s.anchorDate), s.intervalDays) === 0 ? 'due' : 'off';
    case 'times_per_period':
      return 'flexible';
  }
}

describe('schedule engine properties', () => {
  it('every day matches a naive day-by-day evaluation', () => {
    forEachSeed((gen) => {
      const input = gen.input();
      const result = computeSchedule(input);
      const from = parseLocalDate(input.range.from);
      const to = parseLocalDate(input.range.to);
      expect(result.days).toHaveLength(to - from + 1);
      result.days.forEach((d, i) => {
        const day = from + i;
        expect(d.date).toBe(formatLocalDate(day));
        const v = activeOn(input, day) ? versionOn(input, day) : undefined;
        if (!v) {
          expect(d.state).toBe('inactive');
          expect(d.inactiveReason).not.toBeNull();
          expect(d.versionId).toBeNull();
          expect(d.period).toBeNull();
          return;
        }
        const rule = expectedRuleState(v, day);
        expect(d.versionId).toBe(v.id);
        expect(d.graceDays).toBe(v.graceDays);
        expect(d.inactiveReason).toBeNull();
        if (pausedOn(input, day)) {
          expect(d.state).toBe('paused');
          expect(d.pausedState).toBe(rule);
        } else {
          expect(d.state).toBe(rule);
          expect(d.pausedState).toBeNull();
        }
        expect(d.period !== null).toBe(v.schedule.kind === 'times_per_period');
      });
    });
  });

  it('periods contain their days, are counted over the whole period and prorated consistently', () => {
    forEachSeed((gen) => {
      const input = gen.input();
      const result = computeSchedule(input);
      for (const d of result.days) {
        if (d.period === null) continue;
        const p = result.periods[d.period];
        expect(p).toBeDefined();
        if (!p) continue;
        expect(p.versionId).toBe(d.versionId);
        expect(p.start <= d.date && d.date <= p.end).toBe(true);
        const v = input.versions.find((x) => x.id === p.versionId) as ScheduleVersionInput;
        const range = periodOfDay(parseLocalDate(d.date), p.kind, v);
        expect([formatLocalDate(range.start), formatLocalDate(range.end)]).toEqual([
          p.start,
          p.end,
        ]);
        // Recount by brute force over the full calendar period.
        let covered = 0;
        let paused = 0;
        for (let day = range.start; day <= range.end; day += 1) {
          if (activeOn(input, day) && versionOn(input, day)?.id === p.versionId) {
            covered += 1;
            if (pausedOn(input, day)) paused += 1;
          }
        }
        expect([p.coveredDays, p.pausedDays, p.activeDays]).toEqual([
          covered,
          paused,
          covered - paused,
        ]);
        expect(p.totalDays).toBe(range.end - range.start + 1);
        expect(p.required).toBeLessThanOrEqual(Math.min(p.activeDays, p.timesPerPeriod));
        expect(p.required === 0).toBe(p.activeDays === 0);
        if (!p.partial) expect(p.required).toBe(Math.min(p.timesPerPeriod, p.totalDays));
      }
      // Chronological and unique.
      const keys = result.periods.map((p) => `${p.versionId}:${p.start}`);
      expect(new Set(keys).size).toBe(keys.length);
      const starts = result.periods.map((p) => p.start);
      expect([...starts].sort()).toEqual(starts);
    });
  });

  it('is independent of the requested range (sub-range = slice of the larger result)', () => {
    forEachSeed((gen) => {
      const input = gen.input();
      const full = computeSchedule(input);
      const from = parseLocalDate(input.range.from);
      const length = full.days.length;
      const a = gen.int(0, length - 1);
      const b = gen.int(a, length - 1);
      const sub = computeSchedule({
        ...input,
        range: { from: formatLocalDate(from + a), to: formatLocalDate(from + b) },
      });
      const strip = (r: typeof full, d: (typeof full.days)[number]) => ({
        ...d,
        period: d.period === null ? null : r.periods[d.period],
      });
      expect(sub.days.map((d) => strip(sub, d))).toEqual(
        full.days.slice(a, b + 1).map((d) => strip(full, d)),
      );
    });
  });

  it('is deterministic and insensitive to version and pause order', () => {
    forEachSeed((gen) => {
      const input = gen.input();
      const shuffled: ScheduleInput = {
        ...input,
        versions: [...input.versions].reverse(),
        pauses: [...input.pauses].reverse(),
      };
      expect(computeSchedule(shuffled)).toEqual(computeSchedule(input));
    });
  });

  it('a full week of an N×/week version requires N; month periods tile months exactly', () => {
    forEachSeed((gen) => {
      const times = gen.int(1, 7);
      const weekStart = gen.weekStart();
      const calendar = gen.calendar();
      const period = gen.pick(['week', 'month'] as const);
      const result = computeSchedule({
        startsOn: '2020-01-01',
        endsOn: null,
        versions: [
          {
            id: 'v',
            effectiveFrom: '2020-01-01',
            effectiveTo: null,
            schedule: { kind: 'times_per_period', period, timesPerPeriod: times },
            graceDays: 0,
            weekStart,
            calendar,
          },
        ],
        pauses: [],
        range: { from: gen.dateNear('2024-01-01', 0, 700), to: gen.dateNear('2026-06-01', 0, 300) },
      });
      for (const p of result.periods) {
        expect(p.required).toBe(times);
        expect(p.partial).toBe(false);
        const start = parseLocalDate(p.start);
        if (period === 'week') {
          expect(p.totalDays).toBe(7);
        } else {
          expect(monthPositionOf(start, calendar).dayOfMonth).toBe(1);
          expect(monthPositionOf(parseLocalDate(p.end), calendar).dayOfMonth).toBe(p.totalDays);
        }
      }
      for (let i = 1; i < result.periods.length; i += 1) {
        expect(parseLocalDate((result.periods[i] as { start: string }).start)).toBe(
          parseLocalDate((result.periods[i - 1] as { end: string }).end) + 1,
        );
      }
    });
  });

  it('Solar Hijri ↔ Gregorian round-trips for random days in and around the window', () => {
    forEachSeed((gen) => {
      const day = parseLocalDate(gen.dateNear('2050-01-01', -20_000, 20_000));
      const h = dayToSolarHijri(day);
      expect(solarHijriToDay(h.year, h.month, h.day)).toBe(day);
    });
  });
});

describe('performance', () => {
  const heavy = (from: string, to: string): ScheduleInput => {
    const versions: ScheduleVersionInput[] = [];
    const kinds = [
      { kind: 'daily' },
      { kind: 'weekdays', daysOfWeek: [1, 3, 5] },
      { kind: 'monthly_days', daysOfMonth: [1, 15, -1] },
      { kind: 'interval', intervalDays: 3, anchorDate: '2000-01-01' },
      { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
      { kind: 'times_per_period', period: 'month', timesPerPeriod: 12 },
    ] as const;
    // A new version every 30 days, cycling through the kinds and calendars.
    let start = parseLocalDate(from);
    const end = parseLocalDate(to);
    for (let i = 0; start <= end; i += 1, start += 30) {
      versions.push({
        id: `v${i}`,
        effectiveFrom: formatLocalDate(start),
        effectiveTo: start + 30 > end ? null : formatLocalDate(start + 30),
        schedule: structuredClone(kinds[i % kinds.length]) as ScheduleVersionInput['schedule'],
        graceDays: 1,
        weekStart: i % 2 ? 'saturday' : 'monday',
        calendar: i % 3 ? 'gregorian' : 'solar_hijri',
      });
    }
    const pauses = Array.from({ length: 200 }, (_, i) => ({
      startsOn: formatLocalDate(parseLocalDate(from) + i * 17),
      endsOn: formatLocalDate(parseLocalDate(from) + i * 17 + 3),
    }));
    return { startsOn: from, endsOn: null, versions, pauses, range: { from, to } };
  };

  it('computes two years in well under 50 ms', () => {
    const input = heavy('2025-01-01', '2026-12-31');
    computeSchedule(input); // warm up
    const t0 = performance.now();
    const result = computeSchedule(input);
    const ms = performance.now() - t0;
    expect(result.days).toHaveLength(730);
    expect(ms).toBeLessThan(50);
  });

  it('computes the whole window (100 years) in under 1 s', () => {
    const input = heavy('2000-01-01', '2099-12-31');
    const t0 = performance.now();
    const result = computeSchedule(input);
    const ms = performance.now() - t0;
    expect(result.days).toHaveLength(36_525);
    expect(ms).toBeLessThan(1000);
  });
});
