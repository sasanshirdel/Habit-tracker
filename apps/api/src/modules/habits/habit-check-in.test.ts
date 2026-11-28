import type {
  CheckInAction,
  CheckInRefusal,
  DayStatus,
  PeriodStatus,
  StatusResult,
  StatusVersionInput,
} from '@habit/habit-engine';
import {
  API_ERROR_CODES,
  HABIT_CHECK_IN_ACTIONS,
  type HabitCheckIn,
  type HabitCheckInAction,
  type HabitCheckInResult,
  type HabitDayStatus,
  type HabitOccurrenceRecord,
  type HabitPeriodStatus,
  type HabitScheduleVersion,
  type HabitStatusRange,
} from '@habit/shared-types';
import { HABIT_CHECK_IN_ACTIONS as VALIDATION_ACTIONS } from '@habit/shared-validation';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { HabitCheckInAction as DbHabitCheckInAction } from '../../generated/prisma/enums.js';
import type { HabitCheckInErrorCode } from './habit-check-in.service.js';
import {
  habitCheckInRecordSchema,
  habitCheckInResultSchema,
  habitDayStatusSchema,
  habitOccurrenceRecordSchema,
  habitPeriodStatusSchema,
  habitStatusRangeResponseSchema,
} from './habit-check-in.schemas.js';

// Contracts of check-ins and statuses (P3-04, ADR-0031): the engine's results, the shared
// contracts, the OpenAPI response schemas and the database enum describe the same shapes.
describe('check-in and status contracts (P3-04, ADR-0031)', () => {
  it('the engine results are the shared contracts', () => {
    expectTypeOf<DayStatus>().toEqualTypeOf<HabitDayStatus>();
    expectTypeOf<PeriodStatus>().toEqualTypeOf<HabitPeriodStatus>();
    expectTypeOf<StatusResult['days']>().toEqualTypeOf<HabitStatusRange['days']>();
    expectTypeOf<CheckInAction>().toEqualTypeOf<HabitCheckInAction>();
    // A stored version is a status version as it is (without createdAt).
    expectTypeOf<Omit<HabitScheduleVersion, 'createdAt'>>().toExtend<StatusVersionInput>();
  });

  it('response schemas mirror @habit/shared-types', () => {
    expectTypeOf<z.output<typeof habitDayStatusSchema>>().toEqualTypeOf<HabitDayStatus>();
    expectTypeOf<z.output<typeof habitPeriodStatusSchema>>().toEqualTypeOf<HabitPeriodStatus>();
    expectTypeOf<
      z.output<typeof habitStatusRangeResponseSchema>
    >().toEqualTypeOf<HabitStatusRange>();
    expectTypeOf<
      z.output<typeof habitOccurrenceRecordSchema>
    >().toEqualTypeOf<HabitOccurrenceRecord>();
    expectTypeOf<z.output<typeof habitCheckInRecordSchema>>().toEqualTypeOf<HabitCheckIn>();
    expectTypeOf<z.output<typeof habitCheckInResultSchema>>().toEqualTypeOf<HabitCheckInResult>();
  });

  it('actions agree everywhere, and every refusal has an API error code', () => {
    expect([...VALIDATION_ACTIONS]).toEqual([...HABIT_CHECK_IN_ACTIONS]);
    expect(Object.values(DbHabitCheckInAction).sort()).toEqual([...HABIT_CHECK_IN_ACTIONS].sort());
    const refusals: CheckInRefusal[] = ['DATE_IN_FUTURE', 'DATE_NOT_TRACKED', 'SKIP_NOT_ALLOWED'];
    const mapped: Exclude<HabitCheckInErrorCode, 'INVALID_VALUE'>[] = [
      ...refusals,
      'HABIT_ARCHIVED',
      'VERSION_CONFLICT',
      'IDEMPOTENCY_KEY_REUSED',
    ];
    for (const code of mapped) expect(API_ERROR_CODES).toContain(code);
  });

  it('a computed day validates against the published schema', () => {
    const day: HabitDayStatus = {
      date: '2026-11-28',
      status: 'due',
      timing: 'today',
      scheduleState: 'flexible',
      inactiveReason: null,
      pausedState: null,
      versionId: '0195f0b4-0000-7000-8000-000000000001',
      graceDays: 0,
      record: { value: 0, skipped: false },
      progress: { value: 0, target: null, met: false, partial: false, percent: 0 },
      openUntil: '2026-11-29',
      period: 0,
    };
    expect(habitDayStatusSchema.parse(day)).toEqual(day);
  });
});
