/** Returns `baseUrl` pointing at another database on the same server (credentials unchanged). */
export function withDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Throwaway database names are generated here only (never from input), so quoting is safe. */
export function throwawayDatabaseName(): string {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `habit_it_${suffix}`;
}
