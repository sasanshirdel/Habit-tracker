/** Page metadata of a cursor-paginated list (backlog P1-05, ARCHITECTURE §5). */
export interface PageInfo {
  /** Opaque cursor for the next page; `null` on the last page. Pass back unchanged as `?cursor=`. */
  nextCursor: string | null;
  hasMore: boolean;
  /** The page size that was applied. */
  limit: number;
}

/** Response shape of every list endpoint: `GET /api/v1/<things>?limit=&cursor=&sort=`. */
export interface Paginated<T> {
  data: T[];
  page: PageInfo;
}
