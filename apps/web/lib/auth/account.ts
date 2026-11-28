'use client';

import type {
  AccountSessionList,
  RevokeOtherSessionsResponse,
  SecurityEventList,
} from '@habit/shared-types';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { api, csrfTokens } from '@/lib/api/api';
import { sessionQueryKey, type SessionState } from './session';

/**
 * The signed-in user's sessions and security activity (backlog P2-08, ADR-0023). Reads use the
 * cursor-paginated `GET /account/sessions` and `GET /account/security-events`; writes go through
 * the CSRF-protected client. Everything here is UX: the API scopes every row to the session's
 * user and decides what "active" means.
 */

export const accountSessionsQueryKey = ['account', 'sessions'] as const;
export const securityEventsQueryKey = ['account', 'security-events'] as const;

/** Page size of both lists. */
export const ACCOUNT_PAGE_SIZE = 20;

function pageQuery(cursor: string | undefined): string {
  const params = new URLSearchParams({ limit: String(ACCOUNT_PAGE_SIZE) });
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function useAccountSessions() {
  return useInfiniteQuery({
    queryKey: accountSessionsQueryKey,
    queryFn: ({ pageParam, signal }) =>
      api.get<AccountSessionList>(`/account/sessions?${pageQuery(pageParam)}`, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

export function useSecurityEvents() {
  return useInfiniteQuery({
    queryKey: securityEventsQueryKey,
    queryFn: ({ pageParam, signal }) =>
      api.get<SecurityEventList>(`/account/security-events?${pageQuery(pageParam)}`, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}

/** Both lists change after a revocation (one session fewer, one event more). */
async function refreshAccount(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: accountSessionsQueryKey }),
    queryClient.invalidateQueries({ queryKey: securityEventsQueryKey }),
  ]);
}

/**
 * `DELETE /account/sessions/{id}`. Revoking the session of this browser is a sign-out: the API
 * clears the cookie, so local state is dropped like `signOut` does and the gate moves on.
 */
export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, current }: { id: string; current: boolean }) => {
      await api.delete<void>(`/account/sessions/${encodeURIComponent(id)}`);
      return { current };
    },
    onSuccess: async ({ current }) => {
      if (current) {
        csrfTokens.remember(null);
        queryClient.removeQueries({
          predicate: (query) => query.queryKey[0] !== sessionQueryKey[0],
        });
        queryClient.setQueryData<SessionState>(sessionQueryKey, () => ({
          status: 'signed-out',
          reason: 'signed-out',
        }));
        return;
      }
      await refreshAccount(queryClient);
    },
  });
}

/** `POST /account/sessions/revoke-others`: every other session ends, this one stays. */
export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RevokeOtherSessionsResponse>('/account/sessions/revoke-others'),
    onSuccess: () => refreshAccount(queryClient),
  });
}
