import {
  computeSchedule,
  ENGINE_DATE_MAX,
  ENGINE_DATE_MIN,
  ENGINE_LIMITS,
  LAST_DAY,
  type ScheduleVersionInput,
} from '@habit/habit-engine';
import type { HabitScheduleVersion } from '@habit/shared-types';
import {
  HABIT_DATE_MAX,
  HABIT_DATE_MIN,
  HABIT_LIMITS,
  HABIT_SCHEDULE_KINDS,
  LAST_DAY_OF_MONTH,
  habitScheduleRuleSchema,
} from '@habit/shared-validation';
import { describe, expect, it } from 'vitest';

// The schedule engine (P3-02, ADR-0029) has no dependency on zod or the API, so its copies of the
// habit bounds are kept equal to the shared validation (and, through habits.schema.test.ts, to the
// database CHECK constraints) here.
describe('habit engine ↔ habit domain model (ADR-0028/0029)', () => {
  it('uses the same date window and bounds', () => {
    expect([ENGINE_DATE_MIN, ENGINE_DATE_MAX]).toEqual([HABIT_DATE_MIN, HABIT_DATE_MAX]);
    expect(ENGINE_LIMITS).toEqual({
      graceDaysMax: HABIT_LIMITS.graceDaysMax,
      intervalDaysMin: HABIT_LIMITS.intervalDaysMin,
      intervalDaysMax: HABIT_LIMITS.intervalDaysMax,
      timesPerWeekMax: HABIT_LIMITS.timesPerWeekMax,
      timesPerMonthMax: HABIT_LIMITS.timesPerMonthMax,
    });
    expect(LAST_DAY).toBe(LAST_DAY_OF_MONTH);
  });

  const examples = {
    daily: { kind: 'daily' },
    weekdays: { kind: 'weekdays', daysOfWeek: [5, 1, 1] },
    monthly_days: { kind: 'monthly_days', daysOfMonth: [-1, 15] },
    interval: { kind: 'interval', intervalDays: 2, anchorDate: '2026-01-01' },
    times_per_period: { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
  } as const;

  it.each(HABIT_SCHEDULE_KINDS)(
    'computes every validated schedule kind (%s) from a stored version',
    (kind) => {
      const stored: HabitScheduleVersion = {
        id: '0193a3a0-0000-7000-8000-000000000001',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        schedule: habitScheduleRuleSchema.parse(examples[kind]),
        target: null,
        graceDays: HABIT_LIMITS.graceDaysMax,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      // A stored version plus the calendar settings its periods count in is an engine version.
      const version: ScheduleVersionInput = {
        ...stored,
        weekStart: 'saturday',
        calendar: 'solar_hijri',
      };
      const result = computeSchedule({
        startsOn: HABIT_DATE_MIN,
        endsOn: null,
        versions: [version],
        pauses: [],
        range: { from: '2026-01-01', to: '2026-01-31' },
      });
      expect(result.days).toHaveLength(31);
      expect(result.days.some((d) => d.state === 'due' || d.state === 'flexible')).toBe(true);
    },
  );
});
