import type { HabitScheduleRule } from '@habit/shared-types';
import { describe, expect, it } from 'vitest';
import { ScheduleInputError, type ScheduleInputErrorCode } from './errors.js';
import {
  computeSchedule,
  versionIdOn,
  type ScheduleInput,
  type ScheduleVersionInput,
} from './schedule.js';

const version = (
  schedule: HabitScheduleRule,
  over: Partial<ScheduleVersionInput> = {},
): ScheduleVersionInput => ({
  id: 'v1',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  schedule,
  graceDays: 0,
  weekStart: 'monday',
  calendar: 'gregorian',
  ...over,
});

const input = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  startsOn: '2026-01-01',
  endsOn: null,
  versions: [version({ kind: 'daily' })],
  pauses: [],
  range: { from: '2026-01-01', to: '2026-01-31' },
  ...over,
});

/** The dates of a result whose state is `state`. */
const datesIn = (over: Partial<ScheduleInput>, state = 'due') =>
  computeSchedule(input(over))
    .days.filter((d) => d.state === state)
    .map((d) => d.date);

const expectCode = (fn: () => unknown, code: ScheduleInputErrorCode) => {
  try {
    fn();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ScheduleInputError);
    expect((error as ScheduleInputError).code).toBe(code);
  }
};

describe('daily', () => {
  it('is due every day of the range, one entry per date, in order', () => {
    const r = computeSchedule(input());
    expect(r.from).toBe('2026-01-01');
    expect(r.to).toBe('2026-01-31');
    expect(r.days).toHaveLength(31);
    expect(r.days[0]).toEqual({
      date: '2026-01-01',
      state: 'due',
      inactiveReason: null,
      versionId: 'v1',
      graceDays: 0,
      pausedState: null,
      period: null,
    });
    expect(r.days.every((d) => d.state === 'due')).toBe(true);
    expect(r.periods).toEqual([]);
  });

  it('crosses DST transition dates like any other day (local dates only)', () => {
    const r = computeSchedule(input({ range: { from: '2026-03-07', to: '2026-03-09' } }));
    expect(r.days.map((d) => d.date)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
  });

  it('handles a one-day range and the window edges', () => {
    expect(
      computeSchedule(
        input({ startsOn: '2000-01-01', range: { from: '2000-01-01', to: '2000-01-01' } }),
      ).days,
    ).toHaveLength(1);
    const r = computeSchedule(
      input({
        startsOn: '2000-01-01',
        versions: [version({ kind: 'daily' }, { effectiveFrom: '2000-01-01' })],
        range: { from: '2099-12-31', to: '2099-12-31' },
      }),
    );
    expect(r.days[0]?.state).toBe('due');
  });
});

describe('weekdays', () => {
  it('is due on the selected ISO weekdays only', () => {
    // Mon, Wed, Fri in the first week of January 2026 (2026-01-01 is a Thursday).
    expect(
      datesIn({
        versions: [version({ kind: 'weekdays', daysOfWeek: [1, 3, 5] })],
        range: { from: '2026-01-01', to: '2026-01-07' },
      }),
    ).toEqual(['2026-01-02', '2026-01-05', '2026-01-07']);
  });

  it('does not depend on the week start (weekdays are ISO numbers)', () => {
    const due = (weekStart: 'saturday' | 'monday') =>
      datesIn({ versions: [version({ kind: 'weekdays', daysOfWeek: [6, 7] }, { weekStart })] });
    expect(due('saturday')).toEqual(due('monday'));
    expect(due('saturday')).toHaveLength(9); // 5 Saturdays (3..31) + 4 Sundays in January 2026
  });

  it('marks the other days off', () => {
    const r = computeSchedule(
      input({ versions: [version({ kind: 'weekdays', daysOfWeek: [4] })] }),
    );
    expect(r.days.filter((d) => d.state === 'off')).toHaveLength(26);
  });
});

describe('monthly days (Gregorian)', () => {
  const monthly = (daysOfMonth: number[], range: ScheduleInput['range']) =>
    datesIn({ versions: [version({ kind: 'monthly_days', daysOfMonth })], range });

  it('is due on the given days of each month', () => {
    expect(monthly([1, 15], { from: '2026-01-01', to: '2026-03-31' })).toEqual([
      '2026-01-01',
      '2026-01-15',
      '2026-02-01',
      '2026-02-15',
      '2026-03-01',
      '2026-03-15',
    ]);
  });

  it('skips months that do not have the day (no clamping) — use -1 for the last day', () => {
    expect(monthly([31], { from: '2026-01-01', to: '2026-06-30' })).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
    ]);
    expect(monthly([30], { from: '2026-02-01', to: '2026-02-28' })).toEqual([]);
  });

  it('-1 is the last day of every month, including leap February', () => {
    expect(monthly([-1], { from: '2026-01-01', to: '2026-04-30' })).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
    expect(
      datesIn({
        startsOn: '2024-01-01',
        versions: [
          version({ kind: 'monthly_days', daysOfMonth: [-1, 29] }, { effectiveFrom: '2024-01-01' }),
        ],
        range: { from: '2024-02-01', to: '2024-03-01' },
      }),
    ).toEqual(['2024-02-29']); // 29 and "last" are the same day: one due day
  });

  it('treats 2100 as a common year (outside the window it is refused, inside 2096 is leap)', () => {
    expect(
      datesIn({
        startsOn: '2096-01-01',
        versions: [
          version({ kind: 'monthly_days', daysOfMonth: [-1] }, { effectiveFrom: '2096-01-01' }),
        ],
        range: { from: '2096-02-01', to: '2096-02-29' },
      }),
    ).toEqual(['2096-02-29']);
  });
});

describe('monthly days (Solar Hijri)', () => {
  const hijri = (daysOfMonth: number[], range: ScheduleInput['range']) =>
    datesIn({
      startsOn: '2024-01-01',
      versions: [
        version(
          { kind: 'monthly_days', daysOfMonth },
          { effectiveFrom: '2024-01-01', calendar: 'solar_hijri' },
        ),
      ],
      range,
    });

  it('day 1 is 1 of each Persian month', () => {
    // 1 Mehr 1405 = 2026-09-23, 1 Aban = 2026-10-23, 1 Azar = 2026-11-22.
    expect(hijri([1], { from: '2026-09-01', to: '2026-11-30' })).toEqual([
      '2026-09-23',
      '2026-10-23',
      '2026-11-22',
    ]);
  });

  it('day 31 only exists in the first six months', () => {
    expect(hijri([31], { from: '2026-03-21', to: '2027-03-20' })).toEqual([
      '2026-04-20',
      '2026-05-21',
      '2026-06-21',
      '2026-07-22',
      '2026-08-22',
      '2026-09-22',
    ]);
  });

  it('-1 is 30 Esfand in a leap year and 29 Esfand otherwise', () => {
    expect(hijri([-1], { from: '2025-03-01', to: '2025-03-31' })).toEqual(['2025-03-20']); // 30 Esfand 1403
    expect(hijri([-1], { from: '2026-03-01', to: '2026-03-31' })).toEqual(['2026-03-20']); // 29 Esfand 1404
    expect(hijri([30], { from: '2026-02-20', to: '2026-03-20' })).toEqual([]); // no 30 Esfand 1404
  });
});

describe('interval (every N days from the anchor)', () => {
  it('is due on the anchor and every N days after it', () => {
    expect(
      datesIn({
        versions: [version({ kind: 'interval', intervalDays: 3, anchorDate: '2026-01-02' })],
        range: { from: '2026-01-01', to: '2026-01-12' },
      }),
    ).toEqual(['2026-01-02', '2026-01-05', '2026-01-08', '2026-01-11']);
  });

  it('extends before the anchor (an anchor after the version start keeps its cadence)', () => {
    expect(
      datesIn({
        versions: [version({ kind: 'interval', intervalDays: 10, anchorDate: '2026-01-25' })],
        range: { from: '2026-01-01', to: '2026-01-31' },
      }),
    ).toEqual(['2026-01-05', '2026-01-15', '2026-01-25']);
  });

  it('keeps the cadence across a new version with the same anchor, and restarts with a new anchor', () => {
    const versions = [
      version(
        { kind: 'interval', intervalDays: 7, anchorDate: '2026-01-01' },
        { effectiveTo: '2026-01-20' },
      ),
      version(
        { kind: 'interval', intervalDays: 7, anchorDate: '2026-01-01' },
        { id: 'v2', effectiveFrom: '2026-01-20', effectiveTo: '2026-02-01' },
      ),
      version(
        { kind: 'interval', intervalDays: 2, anchorDate: '2026-02-01' },
        { id: 'v3', effectiveFrom: '2026-02-01' },
      ),
    ];
    expect(datesIn({ versions, range: { from: '2026-01-01', to: '2026-02-05' } })).toEqual([
      '2026-01-01',
      '2026-01-08',
      '2026-01-15',
      '2026-01-22',
      '2026-01-29',
      '2026-02-01',
      '2026-02-03',
      '2026-02-05',
    ]);
  });

  it('is unaffected by month lengths, leap days and DST (365-day interval)', () => {
    expect(
      datesIn({
        startsOn: '2023-03-01',
        versions: [
          version(
            { kind: 'interval', intervalDays: 365, anchorDate: '2023-03-01' },
            { effectiveFrom: '2023-03-01' },
          ),
        ],
        range: { from: '2023-03-01', to: '2026-03-31' },
      }),
    ).toEqual(['2023-03-01', '2024-02-29', '2025-02-28', '2026-02-28']);
  });
});

describe('times per period', () => {
  const weekly = (
    times: number,
    over: Partial<ScheduleInput> = {},
    weekStart: 'saturday' | 'monday' = 'monday',
  ) =>
    computeSchedule(
      input({
        versions: [
          version(
            { kind: 'times_per_period', period: 'week', timesPerPeriod: times },
            { weekStart },
          ),
        ],
        ...over,
      }),
    );

  it('marks every active day flexible and links it to its week', () => {
    const r = weekly(3, {
      startsOn: '2026-01-05',
      range: { from: '2026-01-05', to: '2026-01-18' },
    });
    expect(r.days.every((d) => d.state === 'flexible')).toBe(true);
    expect(r.periods).toEqual([
      {
        versionId: 'v1',
        kind: 'week',
        start: '2026-01-05',
        end: '2026-01-11',
        totalDays: 7,
        coveredDays: 7,
        pausedDays: 0,
        activeDays: 7,
        timesPerPeriod: 3,
        required: 3,
        partial: false,
      },
      expect.objectContaining({ start: '2026-01-12', end: '2026-01-18', required: 3 }),
    ]);
    expect(r.days.map((d) => d.period)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('counts weeks from the version week start (Saturday for Persian users)', () => {
    const r = weekly(2, { range: { from: '2026-01-03', to: '2026-01-03' } }, 'saturday');
    expect(r.periods[0]).toMatchObject({ start: '2026-01-03', end: '2026-01-09' });
  });

  it('prorates the first week when the habit starts mid-week', () => {
    // Starts Thursday 2026-01-01: 4 of 7 days → ceil(3 × 4 / 7) = 2.
    const r = weekly(3);
    expect(r.periods[0]).toMatchObject({
      start: '2025-12-29',
      end: '2026-01-04',
      coveredDays: 4,
      activeDays: 4,
      required: 2,
      partial: true,
    });
  });

  it('never requires more than the active days', () => {
    // 7×/week, habit starts on Sunday → 1 active day → 1 required.
    const r = weekly(7, {
      startsOn: '2026-01-04',
      range: { from: '2026-01-04', to: '2026-01-04' },
    });
    expect(r.periods[0]).toMatchObject({ activeDays: 1, required: 1 });
  });

  it('subtracts paused days and requires nothing in a fully paused week', () => {
    const r = weekly(4, {
      startsOn: '2026-01-05',
      pauses: [
        { startsOn: '2026-01-05', endsOn: '2026-01-07' },
        { startsOn: '2026-01-12', endsOn: '2026-01-20' },
      ],
      range: { from: '2026-01-05', to: '2026-01-18' },
    });
    expect(r.periods[0]).toMatchObject({
      coveredDays: 7,
      pausedDays: 3,
      activeDays: 4,
      required: 3,
    });
    expect(r.periods[1]).toMatchObject({
      coveredDays: 7,
      pausedDays: 7,
      activeDays: 0,
      required: 0,
    });
    expect(r.days[0]).toMatchObject({ state: 'paused', pausedState: 'flexible', period: 0 });
  });

  it('computes periods over the whole calendar period, whatever the range', () => {
    const narrow = weekly(3, { range: { from: '2026-01-10', to: '2026-01-10' } });
    const wide = weekly(3, { range: { from: '2026-01-01', to: '2026-01-31' } });
    const day = wide.days.find((d) => d.date === '2026-01-10');
    expect(narrow.periods[0]).toEqual(wide.periods[day?.period ?? -1]);
  });

  it('splits a week between versions, each prorated to its own days', () => {
    const r = computeSchedule(
      input({
        startsOn: '2025-12-01',
        versions: [
          version(
            { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
            { effectiveFrom: '2025-12-01', effectiveTo: '2026-01-08' },
          ),
          version(
            { kind: 'times_per_period', period: 'week', timesPerPeriod: 5 },
            { id: 'v2', effectiveFrom: '2026-01-08' },
          ),
        ],
        range: { from: '2026-01-05', to: '2026-01-11' },
      }),
    );
    expect(r.periods).toEqual([
      expect.objectContaining({
        versionId: 'v1',
        start: '2026-01-05',
        coveredDays: 3,
        required: 2,
      }),
      expect.objectContaining({
        versionId: 'v2',
        start: '2026-01-05',
        coveredDays: 4,
        required: 3,
      }),
    ]);
  });

  it('uses Gregorian or Solar Hijri months, and caps the target at the month length', () => {
    const monthly = (
      calendar: 'gregorian' | 'solar_hijri',
      times: number,
      range: ScheduleInput['range'],
    ) =>
      computeSchedule(
        input({
          startsOn: '2024-01-01',
          versions: [
            version(
              { kind: 'times_per_period', period: 'month', timesPerPeriod: times },
              { effectiveFrom: '2024-01-01', calendar },
            ),
          ],
          range,
        }),
      ).periods;
    expect(monthly('gregorian', 31, { from: '2026-02-10', to: '2026-02-10' })[0]).toMatchObject({
      start: '2026-02-01',
      end: '2026-02-28',
      totalDays: 28,
      required: 28,
      partial: false,
    });
    expect(monthly('solar_hijri', 10, { from: '2026-11-28', to: '2026-11-28' })[0]).toMatchObject({
      start: '2026-11-22', // 1 Azar 1405
      end: '2026-12-21',
      totalDays: 30,
      required: 10,
      partial: false,
    });
    expect(monthly('solar_hijri', 31, { from: '2025-03-10', to: '2025-03-10' })[0]).toMatchObject({
      totalDays: 30, // Esfand 1403 (leap)
      required: 30,
    });
  });

  it('prorates when the habit is archived mid-month', () => {
    const r = computeSchedule(
      input({
        archivedOn: '2026-01-16',
        versions: [version({ kind: 'times_per_period', period: 'month', timesPerPeriod: 10 })],
      }),
    );
    // 15 active days of 31 → ceil(10 × 15 / 31) = 5.
    expect(r.periods[0]).toMatchObject({ coveredDays: 15, activeDays: 15, required: 5 });
    expect(r.days[15]).toMatchObject({
      state: 'inactive',
      inactiveReason: 'archived',
      period: null,
    });
  });
});

describe('habit life, versions, pauses', () => {
  it('is inactive before the start and after the end (both inclusive)', () => {
    const r = computeSchedule(
      input({
        startsOn: '2026-01-10',
        endsOn: '2026-01-20',
        range: { from: '2026-01-09', to: '2026-01-21' },
      }),
    );
    expect(r.days[0]).toMatchObject({
      date: '2026-01-09',
      state: 'inactive',
      inactiveReason: 'before_start',
    });
    expect(r.days[1]).toMatchObject({ date: '2026-01-10', state: 'due' });
    expect(r.days[11]).toMatchObject({ date: '2026-01-20', state: 'due' });
    expect(r.days[12]).toMatchObject({
      date: '2026-01-21',
      state: 'inactive',
      inactiveReason: 'after_end',
    });
  });

  it('a habit that starts and ends on the same day has one active day', () => {
    expect(datesIn({ startsOn: '2026-01-10', endsOn: '2026-01-10' })).toEqual(['2026-01-10']);
  });

  it('is inactive from the archive date on; the end date wins when both apply', () => {
    const r = computeSchedule(
      input({
        endsOn: '2026-01-05',
        archivedOn: '2026-01-03',
        range: { from: '2026-01-01', to: '2026-01-07' },
      }),
    );
    expect(r.days.map((d) => d.inactiveReason)).toEqual([
      null,
      null,
      'archived',
      'archived',
      'archived',
      'after_end',
      'after_end',
    ]);
  });

  it('applies each version on its own half-open range; gaps have no version', () => {
    const versions = [
      version({ kind: 'daily' }, { effectiveTo: '2026-01-05' }),
      version(
        { kind: 'weekdays', daysOfWeek: [1] },
        { id: 'v2', effectiveFrom: '2026-01-08', effectiveTo: '2026-01-13' },
      ),
    ];
    const r = computeSchedule(input({ versions, range: { from: '2026-01-03', to: '2026-01-14' } }));
    expect(r.days.map((d) => [d.date.slice(8), d.state, d.versionId ?? d.inactiveReason])).toEqual([
      ['03', 'due', 'v1'],
      ['04', 'due', 'v1'],
      ['05', 'inactive', 'no_version'],
      ['06', 'inactive', 'no_version'],
      ['07', 'inactive', 'no_version'],
      ['08', 'off', 'v2'],
      ['09', 'off', 'v2'],
      ['10', 'off', 'v2'],
      ['11', 'off', 'v2'],
      ['12', 'due', 'v2'], // Monday
      ['13', 'inactive', 'no_version'],
      ['14', 'inactive', 'no_version'],
    ]);
  });

  it('accepts versions in any order and passes each version grace days through', () => {
    const versions = [
      version({ kind: 'daily' }, { id: 'late', effectiveFrom: '2026-01-10', graceDays: 2 }),
      version({ kind: 'daily' }, { id: 'early', effectiveTo: '2026-01-10', graceDays: 0 }),
    ];
    const r = computeSchedule(input({ versions, range: { from: '2026-01-09', to: '2026-01-10' } }));
    expect(r.days.map((d) => [d.versionId, d.graceDays])).toEqual([
      ['early', 0],
      ['late', 2],
    ]);
  });

  it('with no versions every active day has no version', () => {
    expect(
      computeSchedule(input({ versions: [] })).days.every((d) => d.inactiveReason === 'no_version'),
    ).toBe(true);
  });

  it('marks paused and vacation days paused (overlapping and open-ended), keeping what they would be', () => {
    const r = computeSchedule(
      input({
        versions: [version({ kind: 'weekdays', daysOfWeek: [5] })], // Fridays: 2, 9, 16, 23, 30
        pauses: [
          { startsOn: '2026-01-08', endsOn: '2026-01-10' },
          { startsOn: '2026-01-10', endsOn: '2026-01-12' }, // overlaps the first (a vacation)
          { startsOn: '2026-01-13', endsOn: '2026-01-13' }, // adjacent: merged
          { startsOn: '2026-01-29', endsOn: null }, // until resumed
        ],
      }),
    );
    const paused = r.days.filter((d) => d.state === 'paused');
    expect(paused.map((d) => d.date.slice(8))).toEqual([
      '08',
      '09',
      '10',
      '11',
      '12',
      '13',
      '29',
      '30',
      '31',
    ]);
    expect(paused.find((d) => d.date === '2026-01-09')?.pausedState).toBe('due');
    expect(paused.find((d) => d.date === '2026-01-08')?.pausedState).toBe('off');
    expect(datesIn({ versions: [version({ kind: 'weekdays', daysOfWeek: [5] })] })).toHaveLength(5);
    expect(r.days.filter((d) => d.state === 'due').map((d) => d.date)).toEqual([
      '2026-01-02',
      '2026-01-16',
      '2026-01-23',
    ]);
  });

  it('a pause outside the habit life changes nothing; inactive wins over paused', () => {
    const r = computeSchedule(
      input({ startsOn: '2026-01-10', pauses: [{ startsOn: '2026-01-01', endsOn: '2026-01-09' }] }),
    );
    expect(r.days.slice(0, 9).every((d) => d.state === 'inactive')).toBe(true);
    expect(r.days[9]?.state).toBe('due');
  });

  it('is deterministic: the same input gives the same output', () => {
    const i = input({
      versions: [version({ kind: 'times_per_period', period: 'month', timesPerPeriod: 5 })],
    });
    expect(computeSchedule(i)).toEqual(computeSchedule(structuredClone(i)));
  });

  it('does not mutate its input', () => {
    const i = input({
      versions: [
        version({ kind: 'daily' }, { id: 'b', effectiveFrom: '2026-01-05' }),
        version({ kind: 'daily' }, { id: 'a', effectiveTo: '2026-01-05' }),
      ],
      pauses: [
        { startsOn: '2026-01-20', endsOn: null },
        { startsOn: '2026-01-02', endsOn: '2026-01-03' },
      ],
    });
    const copy = structuredClone(i);
    computeSchedule(i);
    expect(i).toEqual(copy);
  });
});

describe('invalid input is refused, never repaired', () => {
  it.each([
    ['range to before from', { range: { from: '2026-01-02', to: '2026-01-01' } }, 'INVALID_RANGE'],
    [
      'range before the window',
      { range: { from: '1999-12-31', to: '2000-01-01' } },
      'DATE_OUT_OF_WINDOW',
    ],
    [
      'range after the window',
      { range: { from: '2099-12-31', to: '2100-01-01' } },
      'DATE_OUT_OF_WINDOW',
    ],
    ['unreal range date', { range: { from: '2026-02-30', to: '2026-03-01' } }, 'INVALID_DATE'],
    ['missing range', { range: null as unknown as ScheduleInput['range'] }, 'INVALID_RANGE'],
    ['end before start', { endsOn: '2025-12-31' }, 'INVALID_HABIT_DATES'],
    ['unreal start', { startsOn: '2026-1-1' }, 'INVALID_DATE'],
    ['unreal archive date', { archivedOn: 'yesterday' }, 'INVALID_DATE'],
    [
      'versions not an array',
      { versions: null as unknown as ScheduleVersionInput[] },
      'INVALID_VERSION',
    ],
    ['pauses not an array', { pauses: {} as unknown as [] }, 'INVALID_PAUSE'],
    [
      'pause end before start',
      { pauses: [{ startsOn: '2026-01-05', endsOn: '2026-01-04' }] },
      'INVALID_PAUSE',
    ],
    [
      'unreal pause date',
      { pauses: [{ startsOn: '2026-01-05', endsOn: '2026-02-30' }] },
      'INVALID_DATE',
    ],
  ] as const)('%s', (_name, over, code) => {
    expectCode(() => computeSchedule(input(over as Partial<ScheduleInput>)), code);
  });

  it('refuses a non-object input', () => {
    expectCode(() => computeSchedule(null as unknown as ScheduleInput), 'INVALID_RANGE');
  });

  it.each([
    ['empty id', { id: '' }, 'INVALID_VERSION'],
    ['effectiveTo = effectiveFrom', { effectiveTo: '2026-01-01' }, 'INVALID_VERSION'],
    ['effectiveTo before effectiveFrom', { effectiveTo: '2025-12-01' }, 'INVALID_VERSION'],
    ['grace days 8', { graceDays: 8 }, 'INVALID_VERSION'],
    ['grace days -1', { graceDays: -1 }, 'INVALID_VERSION'],
    ['grace days 1.5', { graceDays: 1.5 }, 'INVALID_VERSION'],
  ] as const)('version: %s', (_name, over, code) => {
    expectCode(
      () => computeSchedule(input({ versions: [version({ kind: 'daily' }, over)] })),
      code,
    );
  });

  it('refuses overlapping versions, including two open ones', () => {
    expectCode(
      () =>
        computeSchedule(
          input({
            versions: [
              version({ kind: 'daily' }, { effectiveTo: '2026-01-10' }),
              version({ kind: 'daily' }, { id: 'v2', effectiveFrom: '2026-01-09' }),
            ],
          }),
        ),
      'OVERLAPPING_VERSIONS',
    );
    expectCode(
      () =>
        computeSchedule(
          input({
            versions: [
              version({ kind: 'daily' }),
              version({ kind: 'daily' }, { id: 'v2', effectiveFrom: '2026-02-01' }),
            ],
          }),
        ),
      'OVERLAPPING_VERSIONS',
    );
  });

  const badRules: [string, unknown, Partial<ScheduleVersionInput>?][] = [
    ['null rule', null],
    ['unknown kind', { kind: 'yearly' }],
    ['no weekdays', { kind: 'weekdays', daysOfWeek: [] }],
    ['weekday 0', { kind: 'weekdays', daysOfWeek: [0] }],
    ['weekday 8', { kind: 'weekdays', daysOfWeek: [8] }],
    ['weekdays not a list', { kind: 'weekdays', daysOfWeek: 3 }],
    ['no month days', { kind: 'monthly_days', daysOfMonth: [] }],
    ['month day 0', { kind: 'monthly_days', daysOfMonth: [0] }],
    ['month day 32', { kind: 'monthly_days', daysOfMonth: [32] }],
    ['month day -2', { kind: 'monthly_days', daysOfMonth: [-2] }],
    ['month days not a list', { kind: 'monthly_days' }],
    [
      'monthly with an unknown calendar',
      { kind: 'monthly_days', daysOfMonth: [1] },
      { calendar: 'julian' as 'gregorian' },
    ],
    ['interval 1', { kind: 'interval', intervalDays: 1, anchorDate: '2026-01-01' }],
    ['interval 366', { kind: 'interval', intervalDays: 366, anchorDate: '2026-01-01' }],
    ['interval 2.5', { kind: 'interval', intervalDays: 2.5, anchorDate: '2026-01-01' }],
    ['unknown period', { kind: 'times_per_period', period: 'year', timesPerPeriod: 1 }],
    ['0 per week', { kind: 'times_per_period', period: 'week', timesPerPeriod: 0 }],
    ['8 per week', { kind: 'times_per_period', period: 'week', timesPerPeriod: 8 }],
    ['32 per month', { kind: 'times_per_period', period: 'month', timesPerPeriod: 32 }],
    [
      'bad week start',
      { kind: 'times_per_period', period: 'week', timesPerPeriod: 2 },
      { weekStart: 'friday' as 'monday' },
    ],
    [
      'bad calendar',
      { kind: 'times_per_period', period: 'month', timesPerPeriod: 2 },
      { calendar: 'lunar' as 'gregorian' },
    ],
  ];
  it.each(badRules)('rule: %s', (_name, rule, over) => {
    expectCode(
      () => computeSchedule(input({ versions: [version(rule as HabitScheduleRule, over ?? {})] })),
      'INVALID_RULE',
    );
  });

  it('rule: unreal interval anchor', () => {
    expectCode(
      () =>
        computeSchedule(
          input({
            versions: [version({ kind: 'interval', intervalDays: 2, anchorDate: '2026-02-30' })],
          }),
        ),
      'INVALID_DATE',
    );
  });
});

describe('versionIdOn', () => {
  const versions = [
    { id: 'a', effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01' },
    { id: 'c', effectiveFrom: '2026-03-01', effectiveTo: null },
    { id: 'b', effectiveFrom: '2026-02-01', effectiveTo: '2026-02-15' },
  ];

  it.each([
    ['2025-12-31', null],
    ['2026-01-01', 'a'],
    ['2026-01-31', 'a'],
    ['2026-02-01', 'b'], // effectiveTo is exclusive
    ['2026-02-14', 'b'],
    ['2026-02-15', null], // gap
    ['2026-03-01', 'c'],
    ['2099-12-31', 'c'],
  ])('%s → %s', (date, id) => {
    expect(versionIdOn(versions, date)).toBe(id);
  });

  it('refuses overlaps and unreal dates', () => {
    expectCode(
      () =>
        versionIdOn(
          [...versions, { id: 'd', effectiveFrom: '2026-01-15', effectiveTo: '2026-01-20' }],
          '2026-01-01',
        ),
      'OVERLAPPING_VERSIONS',
    );
    expectCode(() => versionIdOn(versions, '2026-13-01'), 'INVALID_DATE');
  });
});
