import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  HABIT_DELETED_RESTORE_DAYS,
  type HabitDetail,
  type HabitOrder,
  type HabitScheduleChangeOutcome,
  type Paginated,
} from '@habit/shared-types';
import type {
  HabitCreateRequest,
  HabitExpectedVersionQuery,
  HabitListQuery,
  HabitReorderRequest,
  HabitScheduleChangeRequest,
  HabitUpdateRequest,
} from '@habit/shared-validation';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/index.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ApiDoc, ApiTag, validationFailedErrorSchema } from '../../openapi/index.js';
import { habitIdParamSchema, habitNotFoundErrorSchema } from './habit-check-in.schemas.js';
import { HabitService } from './habit.service.js';
import { toHabitsApiError } from './habits-api.errors.js';
import {
  expectedVersionQuerySchema,
  habitConflictErrorSchema,
  habitCreateBodySchema,
  habitDetailSchema,
  habitListQueryParamsSchema,
  habitListSchema,
  habitOrCategoryNotFoundErrorSchema,
  habitOrderSchema,
  habitReorderBodySchema,
  habitScheduleChangeBodySchema,
  habitScheduleChangeOutcomeSchema,
  habitScheduleConflictErrorSchema,
  habitUpdateBodySchema,
} from './habits.schemas.js';

const PROTECTED_NOTE =
  'Signed in only; writes also need the CSRF token (ADR-0019). Rate-limit class `default` ' +
  '(per user). Another user’s habit answers 404 exactly like a missing one.';
const EXPECTED_VERSION_NOTE =
  '`?expectedVersion=` (optional): the habit `version` you last saw; refused with 409 ' +
  '`VERSION_CONFLICT` if it changed meanwhile, unless the request changes nothing.';

const notFound = { description: 'No such habit of yours.', schema: habitNotFoundErrorSchema };
const conflict = { description: 'Conflict.', schema: habitConflictErrorSchema };
const detail = (description: string) => ({ description, schema: habitDetailSchema });

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toHabitsApiError(error);
  }
}

/**
 * Habits API (backlog P3-06, ADR-0032) under `/api/v1/habits`: create, list, read, edit, archive /
 * restore, delete / undelete, reorder and schedule changes. No `@Public`, so the global
 * `AuthGuard` requires a session and, for writes, the CSRF token; every query is owner-scoped.
 * Check-ins and statuses are `HabitCheckInController` (P3-04); the habits UI is P3-07.
 */
@ApiTag('Habits', 'Create, organise, archive and delete your habits and change their schedules.')
@Controller('habits')
export class HabitsController {
  constructor(private readonly habits: HabitService) {}

  @ApiDoc({
    operationId: 'listHabits',
    summary: 'List your habits',
    description:
      'Your habits in your sort order, each with its schedule versions. `status`: `active` ' +
      '(default; archived and deleted habits are never in it), `archived`, or `deleted` (deleted ' +
      `less than ${HABIT_DELETED_RESTORE_DAYS} days ago, still restorable). \`categoryId\`: one ` +
      'category, or `none` for uncategorised (an id that is not one of yours lists nothing). ' +
      PROTECTED_NOTE,
    responses: { 200: { description: 'A page of habits.', schema: habitListSchema } },
  })
  @Get()
  list(
    @CurrentUser() user: RequestPrincipal,
    @Query(new ZodValidationPipe(habitListQueryParamsSchema)) query: HabitListQuery,
  ): Promise<Paginated<HabitDetail>> {
    return mapped(() => this.habits.list(user.userId, query));
  }

  @ApiDoc({
    operationId: 'createHabit',
    summary: 'Create a habit',
    description:
      'Creates a habit of any of the six types with its first schedule version, at the end of ' +
      `your list. ${PROTECTED_NOTE}`,
    responses: {
      201: detail('The new habit.'),
      400: {
        description: 'Malformed body, or rules that do not fit the type.',
        schema: validationFailedErrorSchema,
      },
      404: {
        description: '`categoryId` is not one of your categories.',
        schema: habitOrCategoryNotFoundErrorSchema,
      },
    },
  })
  @HttpCode(HttpStatus.CREATED)
  @Post()
  create(
    @CurrentUser() user: RequestPrincipal,
    @Body(new ZodValidationPipe(habitCreateBodySchema)) body: HabitCreateRequest,
  ): Promise<HabitDetail> {
    return mapped(() => this.habits.create(user.userId, body));
  }

  @ApiDoc({
    operationId: 'reorderHabits',
    summary: 'Reorder your active habits',
    description:
      'Sets the order of your active habits: send every active habit id once, top first. ' +
      'Concurrent reorders are applied one after the other (the last one wins as a whole). An id ' +
      'that is not one of your habits → 404; an archived habit, a missing or an extra active one ' +
      `(the list changed) → 409 \`ORDER_MISMATCH\`. ${PROTECTED_NOTE}`,
    responses: {
      200: { description: 'Your active habits in the new order.', schema: habitOrderSchema },
      404: notFound,
      409: conflict,
    },
  })
  @HttpCode(HttpStatus.OK)
  @Put('order')
  reorder(
    @CurrentUser() user: RequestPrincipal,
    @Body(new ZodValidationPipe(habitReorderBodySchema)) body: HabitReorderRequest,
  ): Promise<HabitOrder> {
    return mapped(() => this.habits.reorder(user.userId, body.habitIds));
  }

  @ApiDoc({
    operationId: 'getHabit',
    summary: 'Get a habit',
    description: `One of your habits (archived ones too) with its schedule versions. ${PROTECTED_NOTE}`,
    responses: { 200: detail('The habit.'), 404: notFound },
  })
  @Get(':habitId')
  get(
    @CurrentUser() user: RequestPrincipal,
    @Param('habitId', new ZodValidationPipe(habitIdParamSchema)) habitId: string,
  ): Promise<HabitDetail> {
    return mapped(() => this.habits.get(user.userId, habitId));
  }

  @ApiDoc({
    operationId: 'updateHabit',
    summary: 'Edit a habit',
    description:
      'Edits name, description, unit, category, icon, colour, preferred time and the start/end ' +
      `dates. ${PROTECTED_NOTE}`,
    responses: {
      200: detail('The habit after the edit.'),
      400: {
        description: 'Malformed body, or a value that does not fit the habit.',
        schema: validationFailedErrorSchema,
      },
      404: {
        description: 'No such habit of yours, or `categoryId` is not one of your categories.',
        schema: habitOrCategoryNotFoundErrorSchema,
      },
      409: conflict,
    },
  })
  @Patch(':habitId')
  update(
    @CurrentUser() user: RequestPrincipal,
    @Param('habitId', new ZodValidationPipe(habitIdParamSchema)) habitId: string,
    @Body(new ZodValidationPipe(habitUpdateBodySchema)) body: HabitUpdateRequest,
  ): Promise<HabitDetail> {
    return mapped(() => this.habits.update(user.userId, habitId, body));
  }

  @ApiDoc({
    operationId: 'deleteHabit',
    summary: 'Delete a habit',
    description:
      'Soft-deletes the habit: it disappears everywhere (404) except the `deleted` list and your ' +
      `data export, can be brought back for ${HABIT_DELETED_RESTORE_DAYS} days with ` +
      '`POST /habits/{habitId}/undelete`, and is then erased with its history by a daily job. ' +
      `Deleting it again inside that window changes nothing. ${EXPECTED_VERSION_NOTE} ${PROTECTED_NOTE}`,
    responses: {
      204: { description: 'Deleted.' },
      404: notFound,
      409: conflict,
    },
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':habitId')
  async delete(
    @CurrentUser() user: RequestPrincipal,
    @Param('habitId', new ZodValidationPipe(habitIdParamSchema)) habitId: string,
    @Query(new ZodValidationPipe(expectedVersionQuerySchema)) query: HabitExpectedVersionQuery,
  ): Promise<void> {
    await mapped(() => this.habits.delete(user.userId, habitId, query.expectedVersion));
  }

  @ApiDoc({
    operationId: 'archiveHabit',
    summary: 'Archive a habit',
    description:
      'Moves the habit out of active views; its history stays and it can be restored. Check-ins ' +
      'are refused while archived (a check-in and an archive of the same habit run one after the ' +
      `other). Archiving an archived habit changes nothing. ${EXPECTED_VERSION_NOTE} ${PROTECTED_NOTE}`,
    responses: { 200: detail('The archived habit.'), 404: notFound, 409: conflict },
  })
  @HttpCode(HttpStatus.OK)
  @Post(':habitId/archive')
  archive(
    @CurrentUser() user: RequestPrincipal,
    @Param('habitId', new ZodValidationPipe(habitIdParamSchema)) habitId: string,
    @Query(new ZodValidationPipe(expectedVersionQuerySchema)) query: HabitExpectedVersionQuery,
  ): Promise<HabitDetail> {
    return mapped(() => this.habits.archive(user.userId, habitId, query.expectedVersion));
  }

  @ApiDoc({
    operationId: 'restoreHabit',
    summary: 'Restore an archived habit',
    description:
      'Brings an archived habit back to the end of your active list (the archived days stay ' +
      `untracked). Restoring an active habit changes nothing. ${EXPECTED_VERSION_NOTE} ${PROTECTED_NOTE}`,
    responses: { 200: detail('The restored habit.'), 404: notFound, 409: conflict },
  })
  @HttpCode(HttpStatus.OK)
  @Post(':habitId/restore')
  restore(
    @CurrentUser() user: RequestPrincipal,
    @Param('habitId', new ZodValidationPipe(habitIdParamSchema)) habitId: string,
    @Query(new ZodValidationPipe(expectedVersionQuerySchema)) query: HabitExpectedVersionQuery,
  ): Promise<HabitDetail> {
    return mapped(() => this.habits.restore(user.userId, habitId, query.expectedVersion));
  }

  @ApiDoc({
    operationId: 'undeleteHabit',
    summary: 'Bring back a deleted habit',
    description:
      `Undoes a delete within ${HABIT_DELETED_RESTORE_DAYS} days: the habit comes back as it was ` +
      '(archived or active; an active one at the end of your list). Later it is gone (404). ' +
      `Undeleting a habit that is not deleted changes nothing. ${EXPECTED_VERSION_NOTE} ${PROTECTED_NOTE}`,
    responses: { 200: detail('The habit.'), 404: notFound, 409: conflict },
  })
  @HttpCode(HttpStatus.OK)
  @Post(':habitId/undelete')
  undelete(
    @CurrentUser() user: RequestPrincipal,
    @Param('habitId', new ZodValidationPipe(habitIdParamSchema)) habitId: string,
    @Query(new ZodValidationPipe(expectedVersionQuerySchema)) query: HabitExpectedVersionQuery,
  ): Promise<HabitDetail> {
    return mapped(() => this.habits.undelete(user.userId, habitId, query.expectedVersion));
  }

  @ApiDoc({
    operationId: 'changeHabitSchedule',
    summary: 'Change a habit’s schedule, target or grace days',
    description:
      'Versioned change (ADR-0030): the rules in effect before the effective date are kept for ' +
      'the days they judged; a version starting on that date is rewritten; identical rules ' +
      'change nothing (`outcome: unchanged`). Every change is recorded in the habit’s audit ' +
      `trail (in your data export). ${PROTECTED_NOTE}`,
    responses: {
      200: { description: 'What changed.', schema: habitScheduleChangeOutcomeSchema },
      400: {
        description:
          'Malformed body, rules that do not fit the type, an effective date outside the habit, or a correction without a reason.',
        schema: validationFailedErrorSchema,
      },
      404: notFound,
      409: { description: 'Conflict.', schema: habitScheduleConflictErrorSchema },
    },
  })
  @HttpCode(HttpStatus.OK)
  @Post(':habitId/schedule-changes')
  changeSchedule(
    @CurrentUser() user: RequestPrincipal,
    @Param('habitId', new ZodValidationPipe(habitIdParamSchema)) habitId: string,
    @Body(new ZodValidationPipe(habitScheduleChangeBodySchema)) body: HabitScheduleChangeRequest,
  ): Promise<HabitScheduleChangeOutcome> {
    return mapped(() => this.habits.changeSchedule(user.userId, habitId, body));
  }
}
