/**
 * Email/password authentication contracts (backlog P2-02, ADR-0018). Input rules live in
 * `@habit/shared-validation`; these are the shapes on the wire.
 */

/** `POST /api/v1/auth/register` request body. */
export interface RegisterRequest {
  email: string;
  password: string;
  /**
   * The UI language the user registered in; stored as their language preference. Same values as
   * `Locale` in `@habit/localization` (this package has no dependencies; the API asserts the two
   * agree).
   */
  locale: 'en' | 'fa';
  /** IANA time zone, e.g. `Asia/Tehran` (habit days are computed in it). */
  timezone: string;
  /** Optional, 1..100 characters. */
  displayName?: string;
}

/**
 * `POST /api/v1/auth/register` — 202. Identical whether or not the address already had an
 * account, so the endpoint cannot be used to find out who is registered. No session is created:
 * the client signs in next.
 */
export interface RegistrationAcceptedResponse {
  status: 'accepted';
}

/** `POST /api/v1/auth/login` request body. */
export interface LoginRequest {
  email: string;
  password: string;
}

/** The signed-in account, as returned by login. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/**
 * `POST /api/v1/auth/login` — 200, with the session in an `HttpOnly` `__Host-session` cookie
 * (never in the body). Wrong email or password → 401 `INVALID_CREDENTIALS`, the same for both.
 */
export interface LoginResponse {
  user: AuthenticatedUser;
  /**
   * CSRF token of the new session (P2-03, ADR-0019). Keep it in memory only and send it in the
   * `X-CSRF-Token` header on every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`).
   */
  csrfToken: string;
}

/**
 * `GET /api/v1/auth/session` — 200 while signed in (401 `UNAUTHENTICATED` otherwise). How the
 * web app learns, after a reload, who is signed in and the session's CSRF token.
 */
export interface SessionResponse {
  user: AuthenticatedUser;
  /** Same token as {@link LoginResponse.csrfToken} for this session. */
  csrfToken: string;
}

/** Request header that carries the CSRF token on state-changing requests (ADR-0019). */
export const CSRF_HEADER_NAME = 'X-CSRF-Token';
