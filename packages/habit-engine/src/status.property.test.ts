/**
 * Property tests for occurrence statuses (P3-04, ADR-0031): seeded random habits of every type
 * (versions with targets, every rule kind the type allows, both calendars, all week starts,
 * pauses, end and archive dates), random records and a random "today", compared day by day with
 * a naive reference implementation of the rules, plus invariants (range independence, record
 * order independence). Seeds are fixed; a failure names its seed.
 */
import type { HabitScheduleRule, HabitTarget, HabitType } from '@habit/shared-types';
import { describe, expect, it } from 'vitest';
import { formatLocalDate, parseLocalDate } from './dates.js';
import { computeSchedule } from './schedule.js';
import {
  computeStatuses,
  statusRecordRange,
  type StatusInput,
  type StatusRecordInput,
  type StatusVersionInput,
} from './status.js';
import { Gen } from './test-support/random.js';

const RUNS = 300;
const TYPES: HabitType[] = ['binary', 'numeric', 'duration', 'frequency', 'negative', 'custom'];

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

function targetFor(gen: Gen, type: HabitType): HabitTarget | null {
  switch (type) {
    case 'binary':
    case 'frequency':
      return null;
    case 'numeric':
      return { comparison: 'at_least', value: gen.pick([0.5, 1, 8, 2.25, 1000]) };
    case 'duration':
      return { comparison: 'at_least', value: gen.pick([60, 600, 1800, 86_400]) };
    case 'negative':
      return { comparison: 'at_most', value: gen.pick([0, 0, 1, 3]) };
    case 'custom':
      return gen.bool()
        ? { comparison: 'at_least', value: gen.pick([0.5, 2.5, 10]) }
        : { comparison: 'at_most', value: gen.pick([0, 2.5, 30]) };
  }
}

function ruleFor(gen: Gen, type: HabitType, from: string): HabitScheduleRule {
  for (;;) {
    const rule = gen.rule(from);
    if ((rule.kind === 'times_per_period') === (type === 'frequency')) return rule;
  }
}

function valueFor(gen: Gen, type: HabitType, target: HabitTarget | null): number {
  if (type === 'binary' || type === 'frequency') return gen.int(0, 1);
  const t = target!.value;
  const v = gen.pick([0, t, t + 1, Math.max(0, t - 1), t / 2, t * 2]);
  if (type === 'duration' || type === 'negative') return Math.round(v);
  return Math.round(v * 1000) / 1000;
}

function randomInput(gen: Gen): StatusInput {
  const base = gen.input();
  const type = gen.pick(TYPES);
  const versions: StatusVersionInput[] = base.versions.map((v) => ({
    ...v,
    schedule: ruleFor(gen, type, v.effectiveFrom),
    target: targetFor(gen, type),
  }));
  const span = statusRecordRange({ ...base, versions });
  const from = parseLocalDate(span.from);
  const to = parseLocalDate(span.to);
  const records: StatusRecordInput[] = [];
  for (let d = from; d <= to; d += 1) {
    if (!gen.bool(0.35)) continue;
    const date = formatLocalDate(d);
    if (gen.bool(0.15)) records.push({ localDate: date, value: null, skipped: true });
    else {
      const v = versions.find(
        (x) => x.effectiveFrom <= date && (x.effectiveTo === null || date < x.effectiveTo),
      );
      records.push({
        localDate: date,
        value: valueFor(gen, type, v?.target ?? targetFor(gen, type)),
        skipped: false,
      });
    }
  }
  const today = gen.dateNear(base.range.from, -30, 600);
  return { ...base, habitType: type, versions, records, today };
}

// ── Reference implementation (naive, day by day) ────────────────────────────────────────────────

function met(type: HabitType, target: HabitTarget | null, value: number): boolean {
  if (target === null) return value === 1;
  const v = Math.round(value * 1000);
  const t = Math.round(target.value * 1000);
  return target.comparison === 'at_least' ? v >= t : v <= t;
}

function referenceStatuses(input: StatusInput): (date: string) => string {
  // The engine's day states over the range widened to whole periods (so every period is complete).
  const span = statusRecordRange(input);
  const all = computeSchedule({ ...input, range: span });
  const origin = parseLocalDate(span.from);
  const recordOn = new Map(input.records.map((r) => [r.localDate, r]));
  return (date) => {
    const day = all.days[parseLocalDate(date) - origin]!;
    const record = recordOn.get(date);
    const version = input.versions.find((v) => v.id === day.versionId);
    const today = input.today;
    if (day.state === 'inactive' || day.state === 'off') return 'not_scheduled';
    if (day.state === 'paused') return 'paused';
    if (record?.skipped) return 'skipped';
    if (record && met(input.habitType, version!.target, record.value!)) return 'completed';
    if (day.state === 'due') {
      if (record && version!.target?.comparison === 'at_most') return 'missed';
      const closes = formatLocalDate(parseLocalDate(date) + version!.graceDays);
      return today > closes ? 'missed' : 'due';
    }
    // flexible: count the whole period by brute force
    const period = all.periods[day.period!]!;
    let completed = 0;
    let skipped = 0;
    for (let d = parseLocalDate(period.start); d <= parseLocalDate(period.end); d += 1) {
      const other = all.days[d - origin];
      if (!other || other.period !== day.period) continue;
      const r = recordOn.get(formatLocalDate(d));
      if (!r) continue;
      if (r.skipped) {
        if (other.state === 'flexible') skipped += 1;
      } else if (r.value === 1) completed += 1;
    }
    const active = period.activeDays - skipped;
    const target =
      active <= 0
        ? 0
        : Math.min(active, Math.ceil((period.timesPerPeriod * active) / period.totalDays));
    if (target === 0 || completed >= target) return 'not_scheduled';
    const closes = formatLocalDate(parseLocalDate(period.end) + version!.graceDays);
    return today > closes ? 'missed' : 'due';
  };
}

describe('statuses — property tests', () => {
  it('match the naive reference on every day, covering every status of every type', () => {
    const seen = new Set<string>();
    forEachSeed((gen) => {
      const input = randomInput(gen);
      const reference = referenceStatuses(input);
      for (const d of computeStatuses(input).days) {
        expect(d.status, `${input.habitType} ${d.date}`).toBe(reference(d.date));
        seen.add(`${input.habitType}:${d.status}`);
      }
    });
    for (const type of TYPES) {
      for (const status of ['completed', 'missed', 'due', 'skipped', 'paused', 'not_scheduled']) {
        expect(seen, `${type}:${status}`).toContain(`${type}:${status}`);
      }
    }
  });

  it('a sub-range gives the same days and periods as the slice of a larger range', () => {
    forEachSeed((gen) => {
      const input = randomInput(gen);
      const whole = computeStatuses(input);
      const a = gen.int(0, whole.days.length - 1);
      const b = gen.int(a, whole.days.length - 1);
      const sub = computeStatuses({
        ...input,
        range: { from: whole.days[a]!.date, to: whole.days[b]!.date },
      });
      const strip = (r: typeof whole, i: number) => {
        const { period, ...day } = r.days[i]!;
        return { ...day, period: period === null ? null : r.periods[period] };
      };
      for (let i = a; i <= b; i += 1) {
        expect(strip(sub, i - a)).toEqual(strip(whole, i));
      }
    });
  });

  it('record order never matters; Completed ⇔ the value meets the target on a scheduled day', () => {
    forEachSeed((gen) => {
      const input = randomInput(gen);
      const r = computeStatuses(input);
      expect(computeStatuses({ ...input, records: [...input.records].reverse() })).toEqual(r);
      for (const d of r.days) {
        if (d.status === 'completed') expect(d.progress?.met).toBe(true);
        if (d.status === 'skipped') expect(d.record?.skipped).toBe(true);
        // A future day is only Missed when an "at most" limit is already exceeded.
        if (d.timing === 'future' && d.status === 'missed') {
          expect(d.progress?.target?.comparison).toBe('at_most');
          expect(d.progress?.met).toBe(false);
        }
        if (d.status === 'not_scheduled' && d.scheduleState === 'due') {
          expect.unreachable('a due day is never Not scheduled');
        }
      }
    });
  });
});
