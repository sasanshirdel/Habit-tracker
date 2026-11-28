import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  HabitOccurrenceRecord,
  HabitOccurrenceStatus,
  HabitScheduleKind,
  HabitType,
} from './index.js';
import { HABIT_TYPE_VALUES } from './index.js';

// Type-level contract tests for the habit domain (P3-01, ADR-0028).
describe('habit contracts', () => {
  it('has the six PRD habit types', () => {
    expect([...HABIT_TYPE_VALUES].sort()).toEqual(
      ['binary', 'custom', 'duration', 'frequency', 'negative', 'numeric'].sort(),
    );
    expectTypeOf<HabitType>().toEqualTypeOf<
      'binary' | 'numeric' | 'duration' | 'frequency' | 'negative' | 'custom'
    >();
  });

  it('schedule kinds and computed statuses', () => {
    expectTypeOf<HabitScheduleKind>().toEqualTypeOf<
      'daily' | 'weekdays' | 'monthly_days' | 'interval' | 'times_per_period'
    >();
    expectTypeOf<HabitOccurrenceStatus>().toEqualTypeOf<
      'completed' | 'missed' | 'due' | 'skipped' | 'paused' | 'not_scheduled'
    >();
  });

  it('a recorded occurrence is keyed by habit and local date', () => {
    expectTypeOf<HabitOccurrenceRecord['localDate']>().toEqualTypeOf<string>();
    expectTypeOf<HabitOccurrenceRecord['value']>().toEqualTypeOf<number | null>();
  });
});
