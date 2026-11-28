import { Injectable } from '@nestjs/common';
import type { HabitCategory, HabitCategoryOrder, Paginated } from '@habit/shared-types';
import type {
  HabitCategoryCreateRequest,
  HabitCategoryUpdateRequest,
  PaginationQuery,
} from '@habit/shared-validation';
import { z } from 'zod';
import { decodeCursor, paginate } from '../../common/pagination/pagination.js';
import { PrismaService, type DatabaseTransaction } from '../../database/index.js';
import { Prisma, type HabitCategory as HabitCategoryRow } from '../../generated/prisma/client.js';
import { toHabitCategory } from './habit-mappers.js';
import { lockCategoryList, nextCategoryPosition } from './habit-locks.js';
import { HabitCategoryNotFoundError } from './habit.repository.js';
import { HabitWriteError } from './habit.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = 'P2002';
const FOREIGN_KEY_VIOLATION = 'P2003';

const categoryCursorSchema = z.strictObject({ position: z.int().min(0), id: z.uuid() });

function knownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function nameTaken(): HabitWriteError {
  return new HabitWriteError('CATEGORY_NAME_TAKEN', 'You already have a category with this name');
}

function versionConflict(currentVersion: number): HabitWriteError {
  return new HabitWriteError('VERSION_CONFLICT', 'The category changed since it was read', {
    currentVersion,
  });
}

async function lockCategoryRow(
  tx: DatabaseTransaction,
  userId: string,
  categoryId: string,
): Promise<HabitCategoryRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM habit_categories
    WHERE id = ${categoryId}::uuid AND user_id = ${userId}::uuid
    FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.habitCategory.findUniqueOrThrow({ where: { id: categoryId } });
}

/**
 * Habit categories (backlog P3-06, ADR-0032): list, create, rename / recolour, reorder, delete.
 * Owner-scoped; another user's category is indistinguishable from a missing one. Names are unique
 * per user case-insensitively (citext) → `CATEGORY_NAME_TAKEN`. Deleting a category that still
 * holds active or archived habits is refused with `CATEGORY_NOT_EMPTY` (the database refuses it
 * too, `NO ACTION`); its soft-deleted habits are detached (they come back uncategorised). Same
 * optimistic-concurrency and list-lock rules as habits.
 */
@Injectable()
export class HabitCategoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: PaginationQuery): Promise<Paginated<HabitCategory>> {
    const after =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor, categoryCursorSchema);
    const rows = await this.prisma.habitCategory.findMany({
      where: {
        userId,
        ...(after
          ? {
              OR: [
                { position: { gt: after.position } },
                { position: after.position, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
    });
    return paginate(rows.map(toHabitCategory), query.limit, (last) => ({
      position: last.position,
      id: last.id,
    }));
  }

  /** Creates a category at the end of the user's list. */
  async create(userId: string, request: HabitCategoryCreateRequest): Promise<HabitCategory> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockCategoryList(tx, userId);
        const position = await nextCategoryPosition(tx, userId);
        const row = await tx.habitCategory.create({
          data: { userId, name: request.name, color: request.color, icon: request.icon, position },
        });
        return toHabitCategory(row);
      });
    } catch (error) {
      if (knownError(error, UNIQUE_VIOLATION)) throw nameTaken();
      throw error;
    }
  }

  /** Renames / recolours a category; a request that changes nothing is answered as is. */
  async update(
    userId: string,
    categoryId: string,
    request: HabitCategoryUpdateRequest,
  ): Promise<HabitCategory> {
    if (!UUID.test(categoryId)) throw new HabitCategoryNotFoundError();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await lockCategoryRow(tx, userId, categoryId);
        if (!row) throw new HabitCategoryNotFoundError();
        const data: { name?: string; color?: string | null; icon?: string | null } = {};
        if (request.name !== undefined && request.name !== row.name) data.name = request.name;
        if (request.color !== undefined && request.color !== row.color) data.color = request.color;
        if (request.icon !== undefined && request.icon !== row.icon) data.icon = request.icon;
        if (Object.keys(data).length === 0) return toHabitCategory(row);
        if (request.expectedVersion !== undefined && request.expectedVersion !== row.version) {
          throw versionConflict(row.version);
        }
        const updated = await tx.habitCategory.update({
          where: { id: row.id },
          data: { ...data, version: { increment: 1 } },
        });
        return toHabitCategory(updated);
      });
    } catch (error) {
      if (knownError(error, UNIQUE_VIOLATION)) throw nameTaken();
      throw error;
    }
  }

  /**
   * Deletes a category. Refused (`CATEGORY_NOT_EMPTY`, with the number of habits) while active or
   * archived habits use it — move or delete them first (ROADMAP #18 item 5 is the owner's call).
   */
  async delete(userId: string, categoryId: string, expectedVersion?: number): Promise<void> {
    if (!UUID.test(categoryId)) throw new HabitCategoryNotFoundError();
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockCategoryList(tx, userId);
        const row = await lockCategoryRow(tx, userId, categoryId);
        if (!row) throw new HabitCategoryNotFoundError();
        if (expectedVersion !== undefined && expectedVersion !== row.version) {
          throw versionConflict(row.version);
        }
        const habitCount = await tx.habit.count({
          where: { userId, categoryId: row.id, deletedAt: null },
        });
        if (habitCount > 0) throw notEmpty(habitCount);
        // Soft-deleted habits keep no reference: undeleted later, they are uncategorised.
        await tx.habit.updateMany({
          where: { userId, categoryId: row.id, deletedAt: { not: null } },
          data: { categoryId: null },
        });
        await tx.habitCategory.delete({ where: { id: row.id } });
      });
    } catch (error) {
      // A habit was moved into the category concurrently: the foreign key refused the delete.
      if (knownError(error, FOREIGN_KEY_VIOLATION)) throw notEmpty(null);
      throw error;
    }
  }

  /**
   * Sets a new order of all the user's categories (exactly all of them, each once; another
   * user's or an unknown id → not found; a stale list → `ORDER_MISMATCH`). Same algorithm and lock
   * discipline as the habit reorder; `version` is not bumped.
   */
  async reorder(userId: string, categoryIds: readonly string[]): Promise<HabitCategoryOrder> {
    const ids = categoryIds.map((id) => id.toLowerCase());
    return this.prisma.$transaction(async (tx) => {
      await lockCategoryList(tx, userId);
      const all = await tx.habitCategory.findMany({
        where: { userId },
        select: { id: true, position: true },
      });
      const known = new Set(all.map((c) => c.id));
      if (ids.some((id) => !known.has(id))) throw new HabitCategoryNotFoundError();
      if (ids.length !== all.length) {
        throw new HabitWriteError(
          'ORDER_MISMATCH',
          'The order must list every category exactly once; read the list again',
          { expected: all.length, received: ids.length },
        );
      }
      const positionOf = new Map(all.map((c) => [c.id, c.position]));
      const writes = ids
        .map((id, position) => ({ id, position }))
        .filter(({ id, position }) => positionOf.get(id) !== position)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const { id, position } of writes) {
        await tx.habitCategory.update({ where: { id }, data: { position } });
      }
      const rows = await tx.habitCategory.findMany({
        where: { userId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      return { data: rows.map(toHabitCategory) };
    });
  }
}

function notEmpty(habitCount: number | null): HabitWriteError {
  return new HabitWriteError(
    'CATEGORY_NOT_EMPTY',
    'The category still holds habits; move or delete them first',
    habitCount === null ? undefined : { habitCount },
  );
}
