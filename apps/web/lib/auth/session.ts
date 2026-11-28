'use client';

import type { AuthenticatedUser, SessionResponse } from '@habit/shared-types';
import { useQuery } from '@tanstack/react-query';
import { api, csrfTokens } from '@/lib/api/api';
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
  /** `reason: 'signed-out'` when the user just signed out here (no `next` back to this page). */
  | { status: 'signed-out'; reason?: 'signed-out' };

export const sessionQueryKey = ['auth', 'session'] as const;

/** How long a known session state is reused before it is checked again (also on focus). */
export const SESSION_STALE_MS = 60_000;

export async function fetchSession(signal?: AbortSignal): Promise<SessionState> {
  try {
    const session = await api.get<SessionResponse>('/auth/session', { signal });
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
