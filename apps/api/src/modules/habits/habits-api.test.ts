import { HttpStatus } from '@nestjs/common';
import {
  API_ERROR_CODES,
  HABIT_DELETED_RESTORE_DAYS,
  HABIT_LIST_STATUSES,
  type Habit,
  type HabitCategory,
  type HabitCategoryOrder,
  type HabitDetail,
  type HabitOrder,
  type HabitScheduleChange,
  type HabitScheduleChangeOutcome,
  type HabitScheduleVersion,
  type Paginated,
} from '@habit/shared-types';
import { HABIT_LIST_STATUS_VALUES } from '@habit/shared-validation';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { ApiException } from '../../common/errors/api-exception.js';
import { HABIT_PURGE_SCHEDULE, HABIT_SCHEDULES } from './habit-purge.js';
import { HabitCategoryNotFoundError, HabitDatesInvalidError } from './habit.repository.js';
import { HabitNotFoundError } from './habit-schedule.service.js';
import {
  HABIT_DELETED_RESTORE_MS,
  HabitWriteError,
  currentVersionIdOn,
  type HabitWriteErrorCode,
} from './habit.service.js';
import { toHabitsApiError } from './habits-api.errors.js';
import {
  habitCategoryListSchema,
  habitCategoryOrderSchema,
  habitCategorySchema,
  habitDetailSchema,
  habitListSchema,
  habitOrderSchema,
  habitScheduleChangeOutcomeSchema,
  habitScheduleChangeRecordSchema,
  habitScheduleVersionSchema,
  habitSchema,
} from './habits.schemas.js';
import { HabitScheduleChangeError } from './schedule-versioning.js';

// Contracts and error mapping of the habits API (P3-06, ADR-0032).
describe('habits API contracts (P3-06, ADR-0032)', () => {
  it('response schemas mirror @habit/shared-types', () => {
    expectTypeOf<z.output<typeof habitSchema>>().toEqualTypeOf<Habit>();
    expectTypeOf<
      z.output<typeof habitScheduleVersionSchema>
    >().toEqualTypeOf<HabitScheduleVersion>();
    expectTypeOf<z.output<typeof habitDetailSchema>>().toEqualTypeOf<HabitDetail>();
    expectTypeOf<z.output<typeof habitListSchema>>().toEqualTypeOf<Paginated<HabitDetail>>();
    expectTypeOf<z.output<typeof habitOrderSchema>>().toEqualTypeOf<HabitOrder>();
    expectTypeOf<
      z.output<typeof habitScheduleChangeRecordSchema>
    >().toEqualTypeOf<HabitScheduleChange>();
    expectTypeOf<
      z.output<typeof habitScheduleChangeOutcomeSchema>
    >().toEqualTypeOf<HabitScheduleChangeOutcome>();
    expectTypeOf<z.output<typeof habitCategorySchema>>().toEqualTypeOf<HabitCategory>();
    expectTypeOf<z.output<typeof habitCategoryListSchema>>().toEqualTypeOf<
      Paginated<HabitCategory>
    >();
    expectTypeOf<z.output<typeof habitCategoryOrderSchema>>().toEqualTypeOf<HabitCategoryOrder>();
  });

  it('list statuses agree, and the restore window is 30 days', () => {
    expect([...HABIT_LIST_STATUS_VALUES]).toEqual([...HABIT_LIST_STATUSES]);
    expect(HABIT_DELETED_RESTORE_DAYS).toBe(30);
    expect(HABIT_DELETED_RESTORE_MS).toBe(30 * 86_400_000);
  });

  it('every conflict code is an API error code', () => {
    const codes: Exclude<HabitWriteErrorCode, 'INVALID_INPUT'>[] = [
      'VERSION_CONFLICT',
      'ORDER_MISMATCH',
      'HABIT_DATES_CONFLICT',
      'CATEGORY_NOT_EMPTY',
      'CATEGORY_NAME_TAKEN',
    ];
    for (const code of codes) expect(API_ERROR_CODES).toContain(code);
  });
});

describe('currentVersionIdOn', () => {
  const versions = [
    { id: 'a', effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01' },
    { id: 'b', effectiveFrom: '2026-02-01', effectiveTo: '2026-03-01' },
  ];
  it('picks the version in effect, else the first (not started) or the last (ended)', () => {
    expect(currentVersionIdOn(versions, '2026-01-15')).toBe('a');
    expect(currentVersionIdOn(versions, '2026-02-01')).toBe('b');
    expect(currentVersionIdOn(versions, '2025-12-31')).toBe('a');
    expect(currentVersionIdOn(versions, '2026-03-01')).toBe('b');
    expect(currentVersionIdOn([], '2026-03-01')).toBeNull();
    expect(
      currentVersionIdOn(
        [{ id: 'open', effectiveFrom: '2026-01-01', effectiveTo: null }],
        '2099-01-01',
      ),
    ).toBe('open');
  });
});

describe('toHabitsApiError', () => {
  const mapped = (error: unknown) => toHabitsApiError(error) as ApiException;

  it('maps not-found errors to 404 NOT_FOUND', () => {
    for (const error of [new HabitNotFoundError(), new HabitCategoryNotFoundError()]) {
      expect(mapped(error).getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(mapped(error).code).toBe('NOT_FOUND');
    }
  });

  it('maps write conflicts to 409 with their code and details', () => {
    const error = mapped(new HabitWriteError('VERSION_CONFLICT', 'x', { currentVersion: 4 }));
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.details).toEqual({ currentVersion: 4 });
    expect(mapped(new HabitWriteError('CATEGORY_NOT_EMPTY', 'x')).code).toBe('CATEGORY_NOT_EMPTY');
  });

  it('maps field-level refusals to 400 VALIDATION_FAILED on the field', () => {
    const invalid = mapped(
      new HabitWriteError('INVALID_INPUT', 'x', {
        issues: [{ field: 'body.unit', code: 'custom', message: 'm' }],
      }),
    );
    expect(invalid.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(invalid.details).toEqual({
      issues: [{ field: 'body.unit', code: 'custom', message: 'm' }],
    });
    const dates = mapped(new HabitDatesInvalidError());
    expect((dates.details as { issues: { field: string }[] }).issues[0]!.field).toBe('body.endsOn');
  });

  it('maps schedule-change refusals (P3-03) onto fields and conflicts', () => {
    const rules = mapped(
      new HabitScheduleChangeError('INVALID_RULES', 'x', [
        { path: ['target', 'value'], message: 'Must be greater than 0' },
      ]),
    );
    expect(rules.code).toBe('VALIDATION_FAILED');
    expect(rules.details).toEqual({
      issues: [{ field: 'body.target.value', code: 'custom', message: 'Must be greater than 0' }],
    });
    const field = (
      code:
        'EFFECTIVE_BEFORE_START' | 'EFFECTIVE_AFTER_END' | 'NO_VERSION_ON_DATE' | 'REASON_REQUIRED',
    ) =>
      (mapped(new HabitScheduleChangeError(code, 'x')).details as { issues: { field: string }[] })
        .issues[0]!.field;
    expect(field('EFFECTIVE_BEFORE_START')).toBe('body.effectiveFrom');
    expect(field('EFFECTIVE_AFTER_END')).toBe('body.effectiveFrom');
    expect(field('NO_VERSION_ON_DATE')).toBe('body.effectiveFrom');
    expect(field('REASON_REQUIRED')).toBe('body.reason');
    expect(mapped(new HabitScheduleChangeError('VERSION_CONFLICT', 'x')).code).toBe(
      'VERSION_CONFLICT',
    );
    expect(mapped(new HabitScheduleChangeError('ORPHANED_RECORDS', 'x')).code).toBe(
      'HABIT_DATES_CONFLICT',
    );
    const inconsistent = new HabitScheduleChangeError('INVALID_VERSIONS', 'x');
    expect(toHabitsApiError(inconsistent)).toBe(inconsistent);
  });

  it('leaves unknown errors alone', () => {
    const error = new Error('boom');
    expect(toHabitsApiError(error)).toBe(error);
  });
});

describe('habit schedules', () => {
  it('purges deleted habits daily after the identity jobs', () => {
    expect(HABIT_SCHEDULES.map((s) => [s.id, s.job.name, s.cron])).toEqual([
      ['habits.deleted-purge-daily', 'habits.deleted-purge', '55 23 * * *'],
    ]);
    expect(HABIT_PURGE_SCHEDULE.job.queue).toBe('system');
  });
});
