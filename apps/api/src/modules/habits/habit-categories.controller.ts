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
import type { HabitCategory, HabitCategoryOrder, Paginated } from '@habit/shared-types';
import type {
  HabitCategoryCreateRequest,
  HabitCategoryReorderRequest,
  HabitCategoryUpdateRequest,
  HabitExpectedVersionQuery,
  PaginationQuery,
} from '@habit/shared-validation';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/index.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ApiDoc, ApiTag } from '../../openapi/index.js';
import { HabitCategoryService } from './habit-category.service.js';
import { toHabitsApiError } from './habits-api.errors.js';
import {
  categoryConflictErrorSchema,
  categoryCreateBodySchema,
  categoryIdParamSchema,
  categoryListQuerySchema,
  categoryReorderBodySchema,
  categoryUpdateBodySchema,
  expectedVersionQuerySchema,
  habitCategoryListSchema,
  habitCategoryNotFoundErrorSchema,
  habitCategoryOrderSchema,
  habitCategorySchema,
} from './habits.schemas.js';

const PROTECTED_NOTE =
  'Signed in only; writes also need the CSRF token (ADR-0019). Rate-limit class `default` ' +
  '(per user). Another user’s category answers 404 exactly like a missing one.';

const notFound = {
  description: 'No such category of yours.',
  schema: habitCategoryNotFoundErrorSchema,
};
const conflict = { description: 'Conflict.', schema: categoryConflictErrorSchema };

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toHabitsApiError(error);
  }
}

/**
 * Habit categories (backlog P3-06, ADR-0032) under `/api/v1/habit-categories`: list, create,
 * rename / recolour, reorder, delete. Session + CSRF via the global guard; owner-scoped.
 */
@ApiTag('Habit categories', 'Group your habits into named, coloured categories.')
@Controller('habit-categories')
export class HabitCategoriesController {
  constructor(private readonly categories: HabitCategoryService) {}

  @ApiDoc({
    operationId: 'listHabitCategories',
    summary: 'List your categories',
    description: `Your categories in your sort order. ${PROTECTED_NOTE}`,
    responses: { 200: { description: 'A page of categories.', schema: habitCategoryListSchema } },
  })
  @Get()
  list(
    @CurrentUser() user: RequestPrincipal,
    @Query(new ZodValidationPipe(categoryListQuerySchema)) query: PaginationQuery,
  ): Promise<Paginated<HabitCategory>> {
    return mapped(() => this.categories.list(user.userId, query));
  }

  @ApiDoc({
    operationId: 'createHabitCategory',
    summary: 'Create a category',
    description: `Adds a category at the end of your list. ${PROTECTED_NOTE}`,
    responses: {
      201: { description: 'The new category.', schema: habitCategorySchema },
      409: conflict,
    },
  })
  @HttpCode(HttpStatus.CREATED)
  @Post()
  create(
    @CurrentUser() user: RequestPrincipal,
    @Body(new ZodValidationPipe(categoryCreateBodySchema)) body: HabitCategoryCreateRequest,
  ): Promise<HabitCategory> {
    return mapped(() => this.categories.create(user.userId, body));
  }

  @ApiDoc({
    operationId: 'reorderHabitCategories',
    summary: 'Reorder your categories',
    description:
      'Sets the order of your categories: every category id once, top first. An id that is not ' +
      'one of yours → 404; a missing one (the list changed) → 409 `ORDER_MISMATCH`. Concurrent ' +
      `reorders apply one after the other. ${PROTECTED_NOTE}`,
    responses: {
      200: { description: 'Your categories in the new order.', schema: habitCategoryOrderSchema },
      404: notFound,
      409: conflict,
    },
  })
  @HttpCode(HttpStatus.OK)
  @Put('order')
  reorder(
    @CurrentUser() user: RequestPrincipal,
    @Body(new ZodValidationPipe(categoryReorderBodySchema)) body: HabitCategoryReorderRequest,
  ): Promise<HabitCategoryOrder> {
    return mapped(() => this.categories.reorder(user.userId, body.categoryIds));
  }

  @ApiDoc({
    operationId: 'updateHabitCategory',
    summary: 'Rename or recolour a category',
    description: `Changes the name, colour and/or icon. ${PROTECTED_NOTE}`,
    responses: {
      200: { description: 'The category after the change.', schema: habitCategorySchema },
      404: notFound,
      409: conflict,
    },
  })
  @Patch(':categoryId')
  update(
    @CurrentUser() user: RequestPrincipal,
    @Param('categoryId', new ZodValidationPipe(categoryIdParamSchema)) categoryId: string,
    @Body(new ZodValidationPipe(categoryUpdateBodySchema)) body: HabitCategoryUpdateRequest,
  ): Promise<HabitCategory> {
    return mapped(() => this.categories.update(user.userId, categoryId, body));
  }

  @ApiDoc({
    operationId: 'deleteHabitCategory',
    summary: 'Delete a category',
    description:
      'Deletes an empty category. While active or archived habits use it the delete is refused ' +
      'with 409 `CATEGORY_NOT_EMPTY` (`details.habitCount`): move or delete them first. Deleted ' +
      'habits in it come back uncategorised if undeleted. `?expectedVersion=` (optional): the ' +
      `category \`version\` you last saw (409 \`VERSION_CONFLICT\` if it changed). ${PROTECTED_NOTE}`,
    responses: { 204: { description: 'Deleted.' }, 404: notFound, 409: conflict },
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':categoryId')
  async delete(
    @CurrentUser() user: RequestPrincipal,
    @Param('categoryId', new ZodValidationPipe(categoryIdParamSchema)) categoryId: string,
    @Query(new ZodValidationPipe(expectedVersionQuerySchema)) query: HabitExpectedVersionQuery,
  ): Promise<void> {
    await mapped(() => this.categories.delete(user.userId, categoryId, query.expectedVersion));
  }
}
