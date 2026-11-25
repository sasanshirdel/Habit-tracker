import type {
  HealthResponse,
  ReadinessChecks,
  ReadinessErrorDetails,
  ReadinessResponse,
} from '@habit/shared-types';
import { queryOptions } from '@tanstack/react-query';
import { api as defaultApi } from '../api';
import type { ApiClient } from '../client';
import { isApiError } from '../errors';

/** Readiness as data: a 503 `NOT_READY` with per-dependency checks is an answer, not a failure. */
export type Readiness =
  | { ready: true; checks: ReadinessChecks; timestamp: string }
  | { ready: false; checks: ReadinessChecks };

function isReadinessDetails(details: unknown): details is ReadinessErrorDetails {
  const checks = (details as { checks?: unknown } | undefined)?.checks;
  return !!checks && typeof checks === 'object' && 'database' in checks && 'redis' in checks;
}

/** Query options for `GET /health` and `GET /health/ready` (backlog P1-12 demo). */
export function healthQueries(client: ApiClient = defaultApi) {
  return {
    live: () =>
      queryOptions({
        queryKey: ['health', 'live'] as const,
        queryFn: ({ signal }) => client.get<HealthResponse>('/health', { signal }),
        refetchInterval: 30_000,
      }),
    ready: () =>
      queryOptions({
        queryKey: ['health', 'ready'] as const,
        queryFn: async ({ signal }): Promise<Readiness> => {
          try {
            const body = await client.get<ReadinessResponse>('/health/ready', { signal });
            return { ready: true, checks: body.checks, timestamp: body.timestamp };
          } catch (error) {
            if (
              isApiError(error) &&
              error.code === 'NOT_READY' &&
              isReadinessDetails(error.details)
            ) {
              return { ready: false, checks: error.details.checks };
            }
            throw error;
          }
        },
        refetchInterval: 30_000,
      }),
  };
}
