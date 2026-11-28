import { CSRF_HEADER_NAME, type SessionResponse } from '@habit/shared-types';
import { createApiClient } from './client';
import { API_BASE_URL, SESSION_PATH } from './config';
import { createCsrfTokenStore } from './csrf';
import { isApiError, type ApiError } from './errors';

/** Client without CSRF wiring; used only for the token lookup itself (a GET). */
const tokenClient = createApiClient({ baseUrl: API_BASE_URL });

/**
 * The session's CSRF token (P2-03, ADR-0019), kept in memory. Sign-in/sign-out code (P2-09)
 * calls `csrfTokens.remember(response.csrfToken)` / `csrfTokens.remember(null)`.
 */
export const csrfTokens = createCsrfTokenStore(async () => {
  try {
    return (await tokenClient.get<SessionResponse>(SESSION_PATH)).csrfToken;
  } catch (error) {
    if (isApiError(error) && error.code === 'UNAUTHENTICATED') return null;
    throw error;
  }
});

/**
 * Client for the public, session-less auth routes (`POST /auth/register`, `POST /auth/login`;
 * P2-09). Those routes never look at a session, so no CSRF token is needed (the API's Origin check
 * still applies, ADR-0019) — and fetching one first would cost a `GET /auth/session` per attempt.
 */
export const publicApi = tokenClient;

type UnauthenticatedListener = (error: ApiError) => void;
let unauthenticatedListener: UnauthenticatedListener | undefined;

/**
 * Registers the app's reaction to a 401 `UNAUTHENTICATED` from any request of {@link api}
 * (P2-09, ADR-0027: re-check the session, then the gate redirects). One listener at a time; the
 * returned function removes it. The session lookup itself never reports — its 401 is the answer
 * "signed out", and reporting it would loop.
 */
export function setUnauthenticatedListener(listener: UnauthenticatedListener): () => void {
  unauthenticatedListener = listener;
  return () => {
    if (unauthenticatedListener === listener) unauthenticatedListener = undefined;
  };
}

/**
 * The app's API client (P1-12): cookies, timeouts, error codes, the CSRF header (P2-03), and the
 * session-ended hook (P2-09).
 */
export const api = createApiClient({
  baseUrl: API_BASE_URL,
  csrf: {
    headerName: CSRF_HEADER_NAME,
    getToken: csrfTokens.get,
    onRejected: csrfTokens.forget,
  },
  onUnauthenticated: (error, path) => {
    if (path === SESSION_PATH) return;
    unauthenticatedListener?.(error);
  },
});
