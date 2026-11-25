import { HttpStatus } from '@nestjs/common';
import type { Paginated } from '@habit/shared-types';
import { z } from 'zod';
import { ApiException } from '../errors/api-exception.js';
import { validationFailed } from '../validation/zod-validation.pipe.js';

/**
 * Cursor pagination helpers (backlog P1-05, ARCHITECTURE §5).
 *
 * Convention for list endpoints:
 * - query `?limit=&cursor=` (`paginationQuerySchema` from @habit/shared-validation) plus an
 *   endpoint-specific `sort` (`sortSchema`) and explicit, typed filter parameters;
 * - keyset pagination: the cursor encodes the sort key(s) + id of the last returned row; the
 *   query fetches `limit + 1` rows "after" it, ordered by the sort key(s) then id (unique,
 *   stable order); `paginate()` trims the extra row and builds the next cursor;
 * - response `{ data, page: { nextCursor, hasMore, limit } }` (`Paginated<T>`).
 *
 * Cursors are opaque base64url JSON. They are **not** a security boundary — the server validates
 * the decoded content with a schema and still applies owner scoping to every query.
 */

export function encodeCursor(position: unknown): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function invalidCursor(): ApiException {
  return new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_CURSOR', 'Invalid pagination cursor.');
}

/** Decodes a cursor and validates its content; anything malformed → 400 `INVALID_CURSOR`. */
export function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  let raw: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalidCursor();
  return parsed.data;
}

/**
 * Builds a page from `limit + 1` fetched rows: if the extra row exists there is a next page and
 * its cursor is built from the last row that is returned.
 */
export function paginate<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (last: T) => unknown,
): Paginated<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : [...rows];
  const last = data.at(-1);
  return {
    data,
    page: {
      nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
      hasMore,
      limit,
    },
  };
}

export type SortDirection = 'asc' | 'desc';
export interface SortField<F extends string> {
  field: F;
  direction: SortDirection;
}

/**
 * Schema for a `sort` query parameter: comma-separated fields, `-` prefix for descending, e.g.
 * `?sort=-createdAt,name`. Only whitelisted fields are accepted (they map to indexed columns);
 * duplicates are rejected. Missing → `defaultSort`.
 */
export function sortSchema<const F extends string>(
  allowed: readonly [F, ...F[]],
  defaultSort: readonly SortField<F>[],
) {
  const allowedSet = new Set<string>(allowed);
  return z
    .string()
    .max(200)
    .optional()
    .transform((value, ctx): SortField<F>[] => {
      if (value === undefined || value === '') return [...defaultSort];
      const fields: SortField<F>[] = [];
      const seen = new Set<string>();
      for (const part of value.split(',')) {
        const direction: SortDirection = part.startsWith('-') ? 'desc' : 'asc';
        const field = direction === 'desc' ? part.slice(1) : part;
        if (!allowedSet.has(field) || seen.has(field)) {
          ctx.addIssue({
            code: 'custom',
            message: `Sort by one or more of: ${allowed.join(', ')} (prefix "-" for descending), each once.`,
          });
          return z.NEVER;
        }
        seen.add(field);
        fields.push({ field: field as F, direction });
      }
      return fields;
    });
}

export { validationFailed };
