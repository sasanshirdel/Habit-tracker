import type { DatabaseTransaction } from '../../database/index.js';
import type { Habit as HabitRow } from '../../generated/prisma/client.js';

/**
 * Locks of the habits module (P3-06, ADR-0032). Two kinds, always taken in this order inside one
 * transaction, so two writers can never wait on each other in a cycle:
 *
 * 1. **The user's list lock** — a transaction-scoped advisory lock per user and list
 *    (`pg_advisory_xact_lock`), for everything that changes which habits are in a list or their
 *    order: create, reorder, archive, restore, delete, undelete (and the same for categories with
 *    the category list lock). It serialises reorders against each other and against membership
 *    changes, so a reorder always sees the complete, current list.
 * 2. **The habit row lock** — `SELECT … FOR UPDATE` on the habit, the lock schedule changes
 *    (P3-03) and check-ins (P3-04) take, for every change of one habit: metadata edits, start/end
 *    date changes, archive / restore / delete / undelete. A check-in therefore runs either wholly
 *    before an archive (and is accepted) or wholly after it (and is refused `HABIT_ARCHIVED`).
 *
 * Writers that need only the row lock (check-ins, schedule changes, metadata edits) never take the
 * list lock, and writers that need both take the list lock first. Reorders take no row lock
 * explicitly; their `UPDATE`s lock the rows they change after the list lock, in id order.
 */

type ListName = 'habits' | 'habit-categories';

async function lockList(tx: DatabaseTransaction, list: ListName, userId: string): Promise<void> {
  // `hashtextextended` → bigint key; a collision between two users only serialises them.
  await tx.$queryRaw`
    SELECT 1 AS locked FROM (
      SELECT pg_advisory_xact_lock(hashtextextended(${`${list}:${userId}`}, 0))
    ) AS l`;
}

/** The user's habit-list lock (held until the transaction ends). */
export function lockHabitList(tx: DatabaseTransaction, userId: string): Promise<void> {
  return lockList(tx, 'habits', userId);
}

/** The user's category-list lock (held until the transaction ends). */
export function lockCategoryList(tx: DatabaseTransaction, userId: string): Promise<void> {
  return lockList(tx, 'habit-categories', userId);
}

/**
 * Locks one of the user's habits (`FOR UPDATE`) and returns its current row, or `null` when the
 * user has no such habit. Deleted habits count as missing unless `deleted: 'include'`.
 */
export async function lockHabitRow(
  tx: DatabaseTransaction,
  userId: string,
  habitId: string,
  options: { deleted?: 'exclude' | 'include' } = {},
): Promise<HabitRow | null> {
  const locked =
    options.deleted === 'include'
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM habits
          WHERE id = ${habitId}::uuid AND user_id = ${userId}::uuid
          FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM habits
          WHERE id = ${habitId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
          FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.habit.findUniqueOrThrow({ where: { id: habitId } });
}

/** The position after every not deleted habit of the user (call under the habit-list lock). */
export async function nextHabitPosition(tx: DatabaseTransaction, userId: string): Promise<number> {
  const { _max } = await tx.habit.aggregate({
    where: { userId, deletedAt: null },
    _max: { position: true },
  });
  return _max.position === null ? 0 : _max.position + 1;
}

/** The position after every category of the user (call under the category-list lock). */
export async function nextCategoryPosition(
  tx: DatabaseTransaction,
  userId: string,
): Promise<number> {
  const { _max } = await tx.habitCategory.aggregate({
    where: { userId },
    _max: { position: true },
  });
  return _max.position === null ? 0 : _max.position + 1;
}
