import { z } from 'zod';

export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;
/** Cursors are opaque to clients; the bound only stops oversized input early. */
export const CURSOR_MAX_LENGTH = 512;

/**
 * Query parameters shared by every list endpoint (backlog P1-05): `?limit=&cursor=`. `limit`
 * arrives as a string and is coerced; the server decodes and verifies `cursor` itself.
 * Endpoints extend this with their own `sort` and filter parameters.
 */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
