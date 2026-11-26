import { CSRF_HEADER_NAME, type SessionResponse } from '@habit/shared-types';
import { createApiClient } from './client';
import { API_BASE_URL } from './config';
import { createCsrfTokenStore } from './csrf';
import { isApiError } from './errors';

/** Client without CSRF wiring; used only for the token lookup itself (a GET). */
const tokenClient = createApiClient({ baseUrl: API_BASE_URL });

/**
 * The session's CSRF token (P2-03, ADR-0019), kept in memory. Sign-in/sign-out code (P2-09)
 * calls `csrfTokens.remember(response.csrfToken)` / `csrfTokens.remember(null)`.
 */
export const csrfTokens = createCsrfTokenStore(async () => {
  try {
    return (await tokenClient.get<SessionResponse>('/auth/session')).csrfToken;
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

/** The app's API client (P1-12): cookies, timeouts, error codes, and the CSRF header (P2-03). */
export const api = createApiClient({
  baseUrl: API_BASE_URL,
  csrf: {
    headerName: CSRF_HEADER_NAME,
    getToken: csrfTokens.get,
    onRejected: csrfTokens.forget,
  },
});
