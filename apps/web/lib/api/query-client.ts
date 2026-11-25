import { QueryClient, isServer } from '@tanstack/react-query';
import { isApiError, type ErrorCode } from './errors';

/**
 * TanStack Query defaults (backlog P1-12).
 *
 * - Retries only failures that may pass on their own — no response, timeouts and 5xx-type codes —
 *   at most twice with exponential backoff (1 s, 2 s; capped at 8 s). Client errors (4xx),
 *   `RATE_LIMITED` (retrying makes it worse; the UI shows the wait) and unknown errors are not
 *   retried. Mutations are never retried automatically (not idempotent in general).
 * - `staleTime` 30 s so navigating between pages does not refetch everything; data still
 *   refreshes on window focus and reconnect.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'QUEUE_UNAVAILABLE',
  'NOT_READY',
]);

export const MAX_QUERY_RETRIES = 2;

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_QUERY_RETRIES && isApiError(error) && RETRYABLE.has(error.code);
}

export function queryRetryDelay(attemptIndex: number): number {
  return Math.min(1000 * 2 ** attemptIndex, 8000);
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
      },
      mutations: { retry: false },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * A fresh client per server render (never share cached data between requests/users), one
 * client for the lifetime of the browser tab.
 */
export function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
