'use client';

import type { AuthenticatedUser, SessionResponse } from '@habit/shared-types';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api, csrfTokens, setUnauthenticatedListener } from '@/lib/api/api';
import { SESSION_PATH } from '@/lib/api/config';
import { isApiError } from '@/lib/api/errors';

/**
 * Who is signed in, as far as the browser can tell (backlog P2-09, ADR-0020).
 *
 * The `__Host-session` cookie is `HttpOnly` and host-only on the API's origin, so neither page
 * scripts nor the Next.js server can read it (ADR-0019, open decision 1). The answer comes from
 * `GET /auth/session`: 200 → signed in (and the session's CSRF token, kept in memory), 401
 * `UNAUTHENTICATED` → signed out. Any other failure (network, 5xx) is an **error**, not "signed
 * out": the app shows a retry instead of bouncing the user to the sign-in page.
 *
 * This is UX only. The API authorizes every request on its own (deny by default since P2-03).
 */
export type SessionState =
  | { status: 'signed-in'; user: AuthenticatedUser }
  /**
   * `reason: 'signed-out'` when the user just signed out here (no `next` back to this page);
   * `'account-deleted'` right after deleting the account here (P2-10: the confirmation page);
   * `'expired'` when a request found the session gone while this tab thought it was signed in
   * (ADR-0027: the sign-in page says so, and `next` leads back to the page).
   */
  | { status: 'signed-out'; reason?: 'signed-out' | 'account-deleted' | 'expired' };

export const sessionQueryKey = ['auth', 'session'] as const;

/** How long a known session state is reused before it is checked again (also on focus). */
export const SESSION_STALE_MS = 60_000;

export async function fetchSession(signal?: AbortSignal): Promise<SessionState> {
  try {
    const session = await api.get<SessionResponse>(SESSION_PATH, { signal });
    csrfTokens.remember(session.csrfToken);
    return { status: 'signed-in', user: session.user };
  } catch (error) {
    if (isApiError(error) && error.code === 'UNAUTHENTICATED') {
      csrfTokens.remember(null);
      return { status: 'signed-out' };
    }
    throw error;
  }
}

export function useSession({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: SESSION_STALE_MS,
    enabled,
  });
}

/**
 * Removes every cached query except the session itself, which is overwritten in place (removing
 * it would detach the components observing it). Used whenever the signed-in user changes or
 * leaves: nobody must see the previous user's data.
 */
export function dropUserData(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionQueryKey[0] });
}

let pendingRecheck: Promise<void> | undefined;

/**
 * Re-checks the session after an API request answered 401 `UNAUTHENTICATED` (backlog P2-09,
 * ADR-0027). The session may have expired, been revoked on another device, or ended by a password
 * reset — or the 401 may be about something else. So the browser asks `GET /auth/session`:
 *
 * - **signed out** → cached user data is dropped and the session state becomes signed out
 *   (`reason: 'expired'` if this tab believed it was signed in); `AuthGate` then sends the user
 *   to sign-in with the current page as the (validated) `next`, and back after signing in;
 * - **still signed in** → nothing changes (no redirect, the request's own error is shown);
 * - **check failed** (offline) → nothing changes; the next request or window focus checks again.
 *
 * Concurrent 401s share one check (no burst of session lookups), and the lookup's own 401 never
 * triggers another check, so this cannot loop.
 */
export function recheckSession(queryClient: QueryClient): Promise<void> {
  if (pendingRecheck) return pendingRecheck;
  const before = queryClient.getQueryData<SessionState>(sessionQueryKey);
  pendingRecheck = queryClient
    .fetchQuery({
      queryKey: sessionQueryKey,
      queryFn: ({ signal }) => fetchSession(signal),
      staleTime: 0,
    })
    .then((state) => {
      if (state.status !== 'signed-out') return;
      dropUserData(queryClient);
      if (before?.status === 'signed-in') {
        queryClient.setQueryData<SessionState>(sessionQueryKey, () => ({
          status: 'signed-out',
          reason: 'expired',
        }));
      }
    })
    .catch(() => {
      // The check itself failed (network, 5xx): keep the current state.
    })
    .finally(() => {
      pendingRecheck = undefined;
    });
  return pendingRecheck;
}

let watching: QueryClient | undefined;

/**
 * Connects {@link recheckSession} to every 401 of the app's API client. Idempotent: the query
 * provider calls it on each render of the tab's (single) query client.
 */
export function watchSessionExpiry(queryClient: QueryClient): void {
  if (watching === queryClient) return;
  watching = queryClient;
  setUnauthenticatedListener(() => void recheckSession(queryClient));
}
