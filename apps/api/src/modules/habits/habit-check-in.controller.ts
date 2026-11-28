import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import type { HabitCheckInResult, HabitStatusRange } from '@habit/shared-types';
import type { HabitCheckInRequest, HabitStatusRangeQuery } from '@habit/shared-validation';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/index.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ApiDoc, ApiTag, validationFailedErrorSchema } from '../../openapi/index.js';
import {
  checkInBodySchema,
  checkInConflictErrorSchema,
  checkInRefusedErrorSchema,
  habitCheckInResultSchema,
  habitIdParamSchema,
  habitNotFoundErrorSchema,
  habitStatusRangeResponseSchema,
  statusRangeQuerySchema,
} from './habit-check-in.schemas.js';
import { HabitCheckInError, HabitCheckInService } from './habit-check-in.service.js';
import { HabitNotFoundError } from './habit-schedule.service.js';

const PROTECTED_NOTE =
  'Signed in only; `POST` also needs the CSRF token (ADR-0019). Rate-limit class `default` ' +
  '(per user). Another user’s habit answers 404 exactly like a missing one.';

/** Maps the service's domain errors onto the API error envelope (ADR-0009). */
function toApiError(error: unknown): unknown {
  if (error instanceof HabitNotFoundError) {
    return new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Habit not found.');
  }
  if (!(error instanceof HabitCheckInError)) return error;
  switch (error.code) {
    case 'INVALID_VALUE':
      return new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Request validation failed.',
        error.details,
      );
    case 'DATE_IN_FUTURE':
    case 'DATE_NOT_TRACKED':
    case 'SKIP_NOT_ALLOWED':
      return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, error.code, error.message);
    case 'VERSION_CONFLICT':
    case 'IDEMPOTENCY_KEY_REUSED':
    case 'HABIT_ARCHIVED':
      return new ApiException(HttpStatus.CONFLICT, error.code, error.message, error.details);
  }
}

/**
 * Check-ins and occurrence statuses of one habit (backlog P3-04, ADR-0031) under
 * `/api/v1/habits/{habitId}`. No `@Public`, so the global `AuthGuard` requires a session and, for
 * `POST`, the CSRF token; queries are owner-scoped (another user's habit → 404). Habit CRUD is
 * P3-06; the weekly matrix (P3-07) reads statuses here.
 */
@ApiTag('Habit check-ins', 'Record what you did on a day and read the computed day statuses.')
@Controller('habits/:habitId')
export class HabitCheckInController {
  constructor(private readonly checkIns: HabitCheckInService) {}

  @ApiDoc({
    operationId: 'checkInHabit',
    summary: 'Record, skip or clear a day',
    description:
      'Applies one check-in operation to a day of your habit: `set` records a value, `skip` ' +
      'excuses a scheduled day, `clear` removes the record. Idempotent by `operationId`: a ' +
      'repeated request with the same id is not applied again (`replayed: true`, current state ' +
      'returned); the same id with a different request is 409 `IDEMPOTENCY_KEY_REUSED`. Days ' +
      'after your today (profile time zone) are refused; values may be recorded on paused and ' +
      'unscheduled days (their status does not change). Archived habits are read-only. ' +
      'Returns the day’s status and, for "N times per period" habits, its period. ' +
      PROTECTED_NOTE,
    responses: {
      200: {
        description: 'The accepted (or replayed) check-in.',
        schema: habitCheckInResultSchema,
      },
      400: {
        description: 'Malformed body, or a value that does not fit the habit type.',
        schema: validationFailedErrorSchema,
      },
      404: { description: 'No such habit of yours.', schema: habitNotFoundErrorSchema },
      409: { description: 'Conflict.', schema: checkInConflictErrorSchema },
      422: { description: 'The day cannot take this check-in.', schema: checkInRefusedErrorSchema },
    },
  })
  @HttpCode(HttpStatus.OK)
  @Post('check-ins')
  async checkIn(
    @CurrentUser() user: RequestPrincipal,
    @Param('habitId', new ZodValidationPipe(habitIdParamSchema)) habitId: string,
    @Body(new ZodValidationPipe(checkInBodySchema)) body: HabitCheckInRequest,
  ): Promise<HabitCheckInResult> {
    try {
      return await this.checkIns.checkIn(user.userId, habitId, body);
    } catch (error) {
      throw toApiError(error);
    }
  }

  @ApiDoc({
    operationId: 'getHabitStatuses',
    summary: 'Statuses of a habit over a date range',
    description:
      'Computed status (Completed, Missed, Due, Skipped, Paused, Not scheduled) and progress of ' +
      'each day of the range, and the weeks/months of "N times per period" habits, judged as of ' +
      `your today in your profile time zone. Archived habits can be read. ${PROTECTED_NOTE}`,
    responses: {
      200: {
        description: 'One entry per day of the range.',
        schema: habitStatusRangeResponseSchema,
      },
      404: { description: 'No such habit of yours.', schema: habitNotFoundErrorSchema },
    },
  })
  @Get('statuses')
  async statuses(
    @CurrentUser() user: RequestPrincipal,
    @Param('habitId', new ZodValidationPipe(habitIdParamSchema)) habitId: string,
    @Query(new ZodValidationPipe(statusRangeQuerySchema)) query: HabitStatusRangeQuery,
  ): Promise<HabitStatusRange> {
    try {
      return await this.checkIns.statuses(user.userId, habitId, query);
    } catch (error) {
      throw toApiError(error);
    }
  }
}
