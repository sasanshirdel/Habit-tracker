/**
 * Occurrence statuses and completion (P3-04, ADR-0031): table-driven per habit type, status and
 * timing, then "N times per period" periods, boundaries, check-in rules and refused input.
 * 2026-01-05 is a Monday; weeks below start on Monday unless a test says otherwise.
 */
import type { HabitScheduleRule, HabitTarget, HabitType } from '@habit/shared-types';
import { describe, expect, it } from 'vitest';
import { ScheduleInputError, type ScheduleInputErrorCode } from './errors.js';
import {
  checkInRefusal,
  computeStatuses,
  judgeValue,
  statusRecordRange,
  type StatusInput,
  type StatusRecordInput,
  type StatusVersionInput,
} from './status.js';

const DAILY: HabitScheduleRule = { kind: 'daily' };
const THREE_A_WEEK: HabitScheduleRule = {
  kind: 'times_per_period',
  period: 'week',
  timesPerPeriod: 3,
};

const version = (
  schedule: HabitScheduleRule,
  target: HabitTarget | null,
  over: Partial<StatusVersionInput> = {},
): StatusVersionInput => ({
  id: 'v1',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  schedule,
  target,
  graceDays: 0,
  weekStart: 'monday',
  calendar: 'gregorian',
  ...over,
});

const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  habitType: 'binary',
  startsOn: '2026-01-01',
  endsOn: null,
  versions: [version(DAILY, null)],
  pauses: [],
  records: [],
  range: { from: '2026-01-05', to: '2026-01-11' },
  today: '2026-01-08',
  ...over,
});

const rec = (localDate: string, value: number | 'skip'): StatusRecordInput =>
  value === 'skip'
    ? { localDate, value: null, skipped: true }
    : { localDate, value, skipped: false };

/** Status of one date. */
const statusOn = (over: Partial<StatusInput>, date: string) => {
  const r = computeStatuses({ ...input(over), range: { from: date, to: date } });
  return r.days[0]!;
};

const expectCode = (fn: () => unknown, code: ScheduleInputErrorCode) => {
  try {
    fn();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduleInputError);
    expect((error as ScheduleInputError).code).toBe(code);
  }
};

const atLeast = (value: number): HabitTarget => ({ comparison: 'at_least', value });
const atMost = (value: number): HabitTarget => ({ comparison: 'at_most', value });

// ── Per-type completion on a due day ────────────────────────────────────────────────────────────

type Row = [
  label: string,
  type: HabitType,
  target: HabitTarget | null,
  record: number | 'skip' | null,
  /** Day relative to today (today = 2026-01-08). */
  offset: number,
  graceDays: number,
  status: string,
  percent: number | null,
];

const TODAY = '2026-01-08';
const dateAt = (offset: number) => `2026-01-${String(8 + offset).padStart(2, '0')}`;

const ROWS: Row[] = [
  // binary: 1 done / 0 not done
  ['binary done yesterday', 'binary', null, 1, -1, 0, 'completed', 100],
  ['binary done today', 'binary', null, 1, 0, 0, 'completed', 100],
  ['binary nothing yesterday', 'binary', null, null, -1, 0, 'missed', null],
  ['binary nothing today', 'binary', null, null, 0, 0, 'due', null],
  ['binary nothing tomorrow', 'binary', null, null, 1, 0, 'due', null],
  ['binary explicit 0 yesterday', 'binary', null, 0, -1, 0, 'missed', 0],
  ['binary explicit 0 today', 'binary', null, 0, 0, 0, 'due', 0],
  ['binary skipped yesterday', 'binary', null, 'skip', -1, 0, 'skipped', null],
  ['binary skipped today', 'binary', null, 'skip', 0, 0, 'skipped', null],
  ['binary nothing 2 days ago, grace 2', 'binary', null, null, -2, 2, 'due', null],
  ['binary nothing 3 days ago, grace 2', 'binary', null, null, -3, 2, 'missed', null],
  ['binary nothing 2 days ago, grace 1', 'binary', null, null, -2, 1, 'missed', null],
  ['binary done late within grace', 'binary', null, 1, -2, 2, 'completed', 100],
  // numeric: at least
  ['numeric exactly target', 'numeric', atLeast(8), 8, -1, 0, 'completed', 100],
  ['numeric above target', 'numeric', atLeast(8), 12, -1, 0, 'completed', 100],
  ['numeric partial today', 'numeric', atLeast(8), 3, 0, 0, 'due', 37],
  ['numeric partial yesterday', 'numeric', atLeast(8), 3, -1, 0, 'missed', 37],
  ['numeric partial within grace', 'numeric', atLeast(8), 3, -1, 1, 'due', 37],
  ['numeric just below (decimals)', 'numeric', atLeast(8), 7.999, 0, 0, 'due', 99],
  ['numeric decimal target met', 'numeric', atLeast(2.5), 2.5, -1, 0, 'completed', 100],
  ['numeric zero yesterday', 'numeric', atLeast(8), 0, -1, 0, 'missed', 0],
  ['numeric skipped', 'numeric', atLeast(8), 'skip', -1, 0, 'skipped', null],
  // duration: whole seconds, at least
  ['duration met', 'duration', atLeast(600), 600, -1, 0, 'completed', 100],
  ['duration one second short', 'duration', atLeast(600), 599, 0, 0, 'due', 99],
  ['duration short yesterday', 'duration', atLeast(600), 599, -1, 0, 'missed', 99],
  ['duration nothing tomorrow', 'duration', atLeast(600), null, 1, 0, 'due', null],
  // negative: lapses, at most
  ['negative zero lapses', 'negative', atMost(0), 0, -1, 0, 'completed', 100],
  ['negative zero lapses today', 'negative', atMost(0), 0, 0, 0, 'completed', 100],
  ['negative a lapse today → missed at once', 'negative', atMost(0), 1, 0, 0, 'missed', 0],
  ['negative within limit', 'negative', atMost(2), 2, -1, 0, 'completed', 100],
  ['negative over limit', 'negative', atMost(2), 3, -1, 0, 'missed', 0],
  ['negative over limit within grace', 'negative', atMost(2), 3, -1, 3, 'missed', 0],
  ['negative nothing recorded yesterday', 'negative', atMost(0), null, -1, 0, 'missed', null],
  ['negative nothing recorded today', 'negative', atMost(0), null, 0, 0, 'due', null],
  ['negative skipped', 'negative', atMost(0), 'skip', -1, 0, 'skipped', null],
  // custom: either comparison
  ['custom at least met', 'custom', atLeast(2.5), 2.5, -1, 0, 'completed', 100],
  ['custom at least partial', 'custom', atLeast(2.5), 2.499, 0, 0, 'due', 99],
  ['custom at most met', 'custom', atMost(30), 30, -1, 0, 'completed', 100],
  ['custom at most exceeded', 'custom', atMost(30), 30.001, 0, 0, 'missed', 0],
  ['custom at most nothing yesterday', 'custom', atMost(30), null, -1, 0, 'missed', null],
];

describe('completion on a due day, per habit type', () => {
  it.each(ROWS)('%s', (_label, type, target, record, offset, graceDays, status, percent) => {
    const date = dateAt(offset);
    const day = statusOn(
      {
        habitType: type,
        versions: [version(DAILY, target, { graceDays })],
        records: record === null ? [] : [rec(date, record)],
        today: TODAY,
      },
      date,
    );
    expect(day.status).toBe(status);
    expect(day.timing).toBe(offset < 0 ? 'past' : offset === 0 ? 'today' : 'future');
    expect(day.scheduleState).toBe('due');
    expect(day.progress?.percent ?? null).toBe(percent);
    if (status === 'due' || status === 'missed') {
      expect(day.openUntil).toBe(dateAt(offset + graceDays));
    } else {
      expect(day.openUntil).toBeNull();
    }
  });

  it('reports the value, the target and partial progress', () => {
    const day = statusOn(
      {
        habitType: 'numeric',
        versions: [version(DAILY, atLeast(8))],
        records: [rec(TODAY, 3)],
      },
      TODAY,
    );
    expect(day.record).toEqual({ value: 3, skipped: false });
    expect(day.progress).toEqual({
      value: 3,
      target: atLeast(8),
      met: false,
      partial: true,
      percent: 37,
    });
  });
});

describe('judgeValue', () => {
  it.each([
    ['binary', null, 1, true, false, 100],
    ['binary', null, 0, false, false, 0],
    ['frequency', null, 1, true, false, 100],
    ['numeric', atLeast(3), 1, false, true, 33],
    ['numeric', atLeast(3), 0, false, false, 0],
    ['numeric', atLeast(0.001), 0.001, true, false, 100],
    ['numeric', atLeast(1_000_000), 999_999.999, false, true, 99],
    ['duration', atLeast(86_400), 86_400, true, false, 100],
    ['negative', atMost(0), 0, true, false, 100],
    ['negative', atMost(0), 5, false, false, 0],
    ['custom', atMost(0.5), 0.5, true, false, 100],
  ] as const)('%s %o value %s', (type, target, value, met, partial, percent) => {
    expect(judgeValue(type, target, value)).toEqual({ value, target, met, partial, percent });
  });

  it('refuses targets that do not fit the type and impossible values', () => {
    expectCode(() => judgeValue('binary', atLeast(1), 1), 'INVALID_VERSION');
    expectCode(() => judgeValue('numeric', null, 1), 'INVALID_VERSION');
    expectCode(() => judgeValue('numeric', atLeast(0), 1), 'INVALID_VERSION');
    expectCode(() => judgeValue('numeric', atLeast(1), -1), 'INVALID_RECORD');
    expectCode(() => judgeValue('numeric', atLeast(1), Number.NaN), 'INVALID_RECORD');
  });
});

// ── Days that ask for nothing ───────────────────────────────────────────────────────────────────

describe('not scheduled and paused days', () => {
  const weekdays: HabitScheduleRule = { kind: 'weekdays', daysOfWeek: [1, 3, 5] };

  it('an off day is Not scheduled, also when something was recorded on it', () => {
    const over = {
      versions: [version(weekdays, null)],
      records: [rec('2026-01-06', 1)],
    };
    const tue = statusOn(over, '2026-01-06');
    expect(tue.status).toBe('not_scheduled');
    expect(tue.scheduleState).toBe('off');
    expect(tue.progress?.met).toBe(true);
    expect(tue.openUntil).toBeNull();
    expect(statusOn(over, '2026-01-07').status).toBe('missed'); // Wednesday, nothing
  });

  it.each([
    ['before the start', { startsOn: '2026-01-07' }, '2026-01-06', 'before_start'],
    ['after the end', { endsOn: '2026-01-06' }, '2026-01-07', 'after_end'],
    ['archived (the archive day itself)', { archivedOn: '2026-01-07' }, '2026-01-07', 'archived'],
    [
      'between versions',
      {
        versions: [
          version(DAILY, null, { effectiveTo: '2026-01-06' }),
          version(DAILY, null, { id: 'v2', effectiveFrom: '2026-01-08' }),
        ],
      },
      '2026-01-07',
      'no_version',
    ],
  ] as const)('%s → Not scheduled (inactive)', (_l, over, date, reason) => {
    const day = statusOn({ ...over, records: [rec(date, 1)] }, date);
    expect(day.status).toBe('not_scheduled');
    expect(day.inactiveReason).toBe(reason);
    expect(day.versionId).toBeNull();
    expect(day.progress).toBeNull(); // no version → nothing to judge against
    expect(day.record).toEqual({ value: 1, skipped: false });
  });

  it('a paused day is Paused whatever the rule says or the record holds', () => {
    const over = {
      versions: [version(weekdays, null)],
      pauses: [{ startsOn: '2026-01-05', endsOn: '2026-01-06' }],
      records: [rec('2026-01-05', 1)],
    };
    const mon = statusOn(over, '2026-01-05');
    expect(mon).toMatchObject({ status: 'paused', pausedState: 'due', openUntil: null });
    expect(mon.progress?.met).toBe(true);
    expect(statusOn(over, '2026-01-06')).toMatchObject({ status: 'paused', pausedState: 'off' });
  });

  it('a vacation with no end pauses every later day', () => {
    const r = computeStatuses(input({ pauses: [{ startsOn: '2026-01-07', endsOn: null }] }));
    expect(r.days.map((d) => d.status)).toEqual([
      'missed',
      'missed',
      'paused',
      'paused',
      'paused',
      'paused',
      'paused',
    ]);
  });
});

describe('versions and targets', () => {
  it('each day is judged against the target of the version in effect on it', () => {
    const versions = [
      version(DAILY, atLeast(8), { effectiveTo: '2026-01-07' }),
      version(DAILY, atLeast(10), { id: 'v2', effectiveFrom: '2026-01-07' }),
    ];
    const records = [rec('2026-01-06', 9), rec('2026-01-07', 9)];
    const r = computeStatuses(input({ habitType: 'numeric', versions, records }));
    expect(r.days[1]).toMatchObject({ date: '2026-01-06', status: 'completed', versionId: 'v1' });
    expect(r.days[2]).toMatchObject({ date: '2026-01-07', status: 'missed', versionId: 'v2' });
    expect(r.days[2]!.progress?.percent).toBe(90);
  });

  it('grace days come from the version in effect', () => {
    const versions = [
      version(DAILY, null, { effectiveTo: '2026-01-07', graceDays: 3 }),
      version(DAILY, null, { id: 'v2', effectiveFrom: '2026-01-07', graceDays: 0 }),
    ];
    const r = computeStatuses(input({ versions }));
    expect(r.days.slice(0, 3).map((d) => d.status)).toEqual(['due', 'due', 'missed']);
    expect(r.days[0]!.openUntil).toBe('2026-01-08');
  });
});

// ── N times per period ──────────────────────────────────────────────────────────────────────────

describe('frequency habits: judged per period', () => {
  const weekly = (over: Partial<StatusInput> = {}) =>
    computeStatuses(
      input({ habitType: 'frequency', versions: [version(THREE_A_WEEK, null)], ...over }),
    );

  it('an open period short of its target: done days Completed, the rest Due', () => {
    const r = weekly({ records: [rec('2026-01-05', 1)], today: '2026-01-07' });
    expect(r.periods).toHaveLength(1);
    expect(r.periods[0]).toMatchObject({
      start: '2026-01-05',
      end: '2026-01-11',
      required: 3,
      target: 3,
      completed: 1,
      remaining: 2,
      skippedDays: 0,
      status: 'in_progress',
      openUntil: '2026-01-11',
    });
    expect(r.days.map((d) => d.status)).toEqual([
      'completed',
      'due', // a past undone day is not missed while the period can still be met
      'due',
      'due',
      'due',
      'due',
      'due',
    ]);
    expect(r.days[1]).toMatchObject({ scheduleState: 'flexible', openUntil: '2026-01-11' });
    expect(r.days.every((d) => d.period === 0)).toBe(true);
  });

  it('a met period: undone days ask for nothing more (Not scheduled)', () => {
    const records = ['2026-01-05', '2026-01-06', '2026-01-07'].map((d) => rec(d, 1));
    const r = weekly({ records, today: '2026-01-07' });
    expect(r.periods[0]).toMatchObject({ completed: 3, remaining: 0, status: 'met' });
    expect(r.days.map((d) => d.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'not_scheduled',
      'not_scheduled',
      'not_scheduled',
      'not_scheduled',
    ]);
    expect(r.days[3]!.openUntil).toBeNull();
  });

  it('a closed period short of its target: undone days are Missed; grace keeps it open', () => {
    const records = [rec('2026-01-05', 1), rec('2026-01-06', 0)];
    const closed = weekly({ records, today: '2026-01-12' });
    expect(closed.periods[0]!.status).toBe('missed');
    expect(closed.days.map((d) => d.status)).toEqual([
      'completed',
      'missed',
      'missed',
      'missed',
      'missed',
      'missed',
      'missed',
    ]);
    const graced = computeStatuses(
      input({
        habitType: 'frequency',
        versions: [version(THREE_A_WEEK, null, { graceDays: 1 })],
        records,
        today: '2026-01-12',
      }),
    );
    expect(graced.periods[0]).toMatchObject({ status: 'in_progress', openUntil: '2026-01-12' });
    expect(graced.days[1]!.status).toBe('due');
  });

  it('skips excuse days: the target is prorated again over the remaining days', () => {
    const skip = (dates: string[]) => dates.map((d) => rec(d, 'skip'));
    // 2 skips: 5 active days → ceil(3 × 5 / 7) = 3
    expect(weekly({ records: skip(['2026-01-05', '2026-01-06']) }).periods[0]).toMatchObject({
      skippedDays: 2,
      target: 3,
    });
    // 4 skips: 3 active days → ceil(3 × 3 / 7) = 2
    const four = weekly({
      records: [
        ...skip(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']),
        rec('2026-01-09', 1),
      ],
      today: '2026-01-12',
    });
    expect(four.periods[0]).toMatchObject({ skippedDays: 4, target: 2, completed: 1 });
    expect(four.periods[0]!.status).toBe('missed');
    expect(four.days.map((d) => d.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'completed',
      'missed',
      'missed',
    ]);
    // every day skipped → nothing required
    const all = weekly({
      records: skip(['05', '06', '07', '08', '09', '10', '11'].map((d) => `2026-01-${d}`)),
      today: '2026-01-12',
    });
    expect(all.periods[0]).toMatchObject({ target: 0, status: 'not_required' });
  });

  it('a habit starting mid-week has a prorated target; completions on paused days count', () => {
    const r = weekly({
      startsOn: '2026-01-08',
      versions: [version(THREE_A_WEEK, null, { effectiveFrom: '2026-01-08' })],
      pauses: [{ startsOn: '2026-01-10', endsOn: '2026-01-11' }],
      records: [rec('2026-01-08', 1), rec('2026-01-10', 1)],
      today: '2026-01-09',
    });
    // 4 covered days, 2 paused → 2 active → min(2, ceil(3 × 2 / 7)) = 1
    expect(r.periods[0]).toMatchObject({ coveredDays: 4, activeDays: 2, target: 1, completed: 2 });
    expect(r.periods[0]!.status).toBe('met');
    expect(r.days.map((d) => d.status)).toEqual([
      'not_scheduled',
      'not_scheduled',
      'not_scheduled',
      'completed',
      'not_scheduled',
      'paused',
      'paused',
    ]);
  });

  it('a fully paused week requires nothing', () => {
    const r = weekly({ pauses: [{ startsOn: '2026-01-01', endsOn: '2026-01-31' }] });
    expect(r.periods[0]).toMatchObject({ activeDays: 0, target: 0, status: 'not_required' });
    expect(r.days.every((d) => d.status === 'paused')).toBe(true);
  });

  it('counts records anywhere in the period, also outside the requested range', () => {
    const records = ['2026-01-05', '2026-01-06', '2026-01-07'].map((d) => rec(d, 1));
    const sunday = computeStatuses(
      input({
        habitType: 'frequency',
        versions: [version(THREE_A_WEEK, null)],
        records,
        range: { from: '2026-01-11', to: '2026-01-11' },
      }),
    );
    expect(sunday.periods).toHaveLength(1);
    expect(sunday.periods[0]).toMatchObject({ completed: 3, status: 'met' });
    expect(sunday.days[0]).toMatchObject({ status: 'not_scheduled', period: 0 });
  });

  it('month periods follow the version calendar (Solar Hijri Dey 1404 = 2025-12-22..2026-01-20)', () => {
    const r = computeStatuses(
      input({
        habitType: 'frequency',
        startsOn: '2025-12-01',
        versions: [
          version({ kind: 'times_per_period', period: 'month', timesPerPeriod: 2 }, null, {
            effectiveFrom: '2025-12-01',
            calendar: 'solar_hijri',
          }),
        ],
        records: [rec('2025-12-22', 1), rec('2026-01-20', 1)],
        range: { from: '2026-01-20', to: '2026-01-21' },
        today: '2026-01-21',
      }),
    );
    expect(r.periods.map((p) => [p.start, p.end, p.status])).toEqual([
      ['2025-12-22', '2026-01-20', 'met'],
      ['2026-01-21', '2026-02-19', 'in_progress'],
    ]);
    expect(r.days.map((d) => d.period)).toEqual([0, 1]);
  });

  it('a version change mid-week splits the week into two periods', () => {
    const r = weekly({
      versions: [
        version(THREE_A_WEEK, null, { effectiveTo: '2026-01-08' }),
        version({ kind: 'times_per_period', period: 'week', timesPerPeriod: 7 }, null, {
          id: 'v2',
          effectiveFrom: '2026-01-08',
        }),
      ],
      records: [rec('2026-01-05', 1), rec('2026-01-06', 1), rec('2026-01-08', 1)],
      today: '2026-01-11',
    });
    expect(r.periods.map((p) => [p.versionId, p.target, p.completed, p.status])).toEqual([
      ['v1', 2, 2, 'met'], // 3 of 7 days → ceil(9/7) = 2
      ['v2', 4, 1, 'in_progress'], // 4 of 7 days → 4
    ]);
  });
});

// ── Range, today, records ───────────────────────────────────────────────────────────────────────

describe('statusRecordRange', () => {
  it('is the range itself without periods', () => {
    expect(
      statusRecordRange({
        startsOn: '2026-01-01',
        endsOn: null,
        versions: [version(DAILY, null)],
        pauses: [],
        range: { from: '2026-01-07', to: '2026-01-08' },
      }),
    ).toEqual({ from: '2026-01-07', to: '2026-01-08' });
  });

  it('widens to whole periods, clamped to the supported window', () => {
    const v = version(THREE_A_WEEK, null, { effectiveFrom: '2000-01-01' });
    expect(
      statusRecordRange({
        startsOn: '2000-01-01',
        endsOn: null,
        versions: [v],
        pauses: [],
        range: { from: '2000-01-01', to: '2000-01-01' }, // a Saturday; the week began in 1999
      }),
    ).toEqual({ from: '2000-01-01', to: '2000-01-02' });
    expect(
      statusRecordRange({
        startsOn: '2026-01-01',
        endsOn: null,
        versions: [version(THREE_A_WEEK, null)],
        pauses: [],
        range: { from: '2026-01-07', to: '2026-01-13' },
      }),
    ).toEqual({ from: '2026-01-05', to: '2026-01-18' });
  });
});

describe('result shape', () => {
  it('one day per date, today and the range echoed', () => {
    const r = computeStatuses(input());
    expect(r).toMatchObject({ from: '2026-01-05', to: '2026-01-11', today: '2026-01-08' });
    expect(r.days.map((d) => d.date)).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-10',
      '2026-01-11',
    ]);
    expect(r.days.map((d) => d.timing)).toEqual([
      'past',
      'past',
      'past',
      'today',
      'future',
      'future',
      'future',
    ]);
    expect(r.periods).toEqual([]);
  });

  it('does not mutate its input and ignores record order', () => {
    const records = [rec('2026-01-07', 1), rec('2026-01-05', 'skip')];
    const frozen = input({ records });
    const copy = structuredClone(frozen);
    const a = computeStatuses(frozen);
    expect(frozen).toEqual(copy);
    expect(computeStatuses(input({ records: [...records].reverse() }))).toEqual(a);
  });
});

describe('refused input', () => {
  it.each([
    ['two records on one day', { records: [rec('2026-01-05', 1), rec('2026-01-05', 0)] }],
    [
      'a record with value and skip',
      { records: [{ localDate: '2026-01-05', value: 1, skipped: true }] },
    ],
    [
      'a record with neither',
      { records: [{ localDate: '2026-01-05', value: null, skipped: false }] },
    ],
    ['records not an array', { records: null as unknown as StatusRecordInput[] }],
  ])('%s → INVALID_RECORD', (_l, over) => {
    expectCode(() => computeStatuses(input(over)), 'INVALID_RECORD');
  });

  it('an unreal record date → INVALID_DATE', () => {
    expectCode(() => computeStatuses(input({ records: [rec('2026-02-30', 1)] })), 'INVALID_DATE');
  });

  it.each([
    ['frequency without times_per_period', { habitType: 'frequency' as const }],
    ['binary with times_per_period', { versions: [version(THREE_A_WEEK, null)] }],
    ['numeric without target', { habitType: 'numeric' as const }],
    ['binary with a target', { versions: [version(DAILY, atLeast(1))] }],
    ['an unknown type', { habitType: 'boolean' as unknown as HabitType }],
    ['versions not an array', { versions: null as unknown as StatusVersionInput[] }],
  ])('%s → INVALID_VERSION', (_l, over) => {
    expectCode(() => computeStatuses(input(over)), 'INVALID_VERSION');
  });

  it('an invalid today → INVALID_DATE; no input → INVALID_RANGE', () => {
    expectCode(() => computeStatuses(input({ today: '2026-1-8' })), 'INVALID_DATE');
    expectCode(() => computeStatuses(null as unknown as StatusInput), 'INVALID_RANGE');
  });
});

// ── Check-in rules ──────────────────────────────────────────────────────────────────────────────

describe('checkInRefusal', () => {
  it.each([
    ['set', '2026-01-09', 'due', 'DATE_IN_FUTURE'],
    ['skip', '2026-01-09', 'due', 'DATE_IN_FUTURE'],
    ['clear', '2026-01-09', 'due', 'DATE_IN_FUTURE'],
    ['set', '2026-01-08', 'due', null],
    ['set', '2020-01-01', 'flexible', null],
    ['set', '2026-01-08', 'off', null],
    ['set', '2026-01-08', 'paused', null],
    ['set', '2026-01-08', 'inactive', 'DATE_NOT_TRACKED'],
    ['skip', '2026-01-08', 'due', null],
    ['skip', '2026-01-08', 'flexible', null],
    ['skip', '2026-01-08', 'off', 'SKIP_NOT_ALLOWED'],
    ['skip', '2026-01-08', 'paused', 'SKIP_NOT_ALLOWED'],
    ['skip', '2026-01-08', 'inactive', 'DATE_NOT_TRACKED'],
    ['clear', '2026-01-08', 'inactive', null],
    ['clear', '2026-01-07', 'off', null],
  ] as const)('%s on %s (%s) → %s', (action, date, state, expected) => {
    expect(checkInRefusal(action, date, '2026-01-08', { state })).toBe(expected);
  });
});
