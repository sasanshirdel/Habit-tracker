import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../../common/errors/api-exception.js';
import { HabitCategoryNotFoundError, HabitDatesInvalidError } from './habit.repository.js';
import { HabitNotFoundError } from './habit-schedule.service.js';
import { HabitWriteError } from './habit.service.js';
import { HabitScheduleChangeError } from './schedule-versioning.js';

function fieldIssue(field: string, message: string): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'VALIDATION_FAILED',
    'Request validation failed.',
    {
      issues: [{ field: `body.${field}`, code: 'custom', message }],
    },
  );
}

/**
 * Maps the habits module's domain errors onto the API error envelope (ADR-0009, ADR-0032).
 * Anything else is returned unchanged (the global filter answers 500 without detail).
 */
export function toHabitsApiError(error: unknown): unknown {
  if (error instanceof HabitNotFoundError) {
    return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Habit not found.');
  }
  if (error instanceof HabitCategoryNotFoundError) {
    return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Habit category not found.');
  }
  if (error instanceof HabitDatesInvalidError) {
    return fieldIssue('endsOn', 'Must not end before it starts');
  }
  if (error instanceof HabitWriteError) {
    if (error.code === 'INVALID_INPUT') {
      return new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Request validation failed.',
        error.details,
      );
    }
    return new ApiException(HttpStatus.CONFLICT, error.code, error.message, error.details);
  }
  if (error instanceof HabitScheduleChangeError) {
    switch (error.code) {
      case 'INVALID_RULES':
        return new ApiException(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_FAILED',
          'Request validation failed.',
          {
            issues: error.issues.map((issue) => ({
              field: ['body', ...issue.path.map(String)].join('.'),
              code: 'custom',
              message: issue.message,
            })),
          },
        );
      case 'EFFECTIVE_BEFORE_START':
      case 'EFFECTIVE_AFTER_END':
      case 'NO_VERSION_ON_DATE':
        return fieldIssue('effectiveFrom', error.message);
      case 'REASON_REQUIRED':
        return fieldIssue('reason', error.message);
      case 'VERSION_CONFLICT':
        return new ApiException(HttpStatus.CONFLICT, 'VERSION_CONFLICT', error.message);
      case 'ORPHANED_RECORDS':
        return new ApiException(HttpStatus.CONFLICT, 'HABIT_DATES_CONFLICT', error.message, {
          reason: 'records_outside_dates',
        });
      case 'INVALID_VERSIONS':
        return error; // stored data is inconsistent: a 500, logged by the global filter
    }
  }
  return error;
}
