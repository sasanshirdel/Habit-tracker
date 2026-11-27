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
  /** Optional, up to 100 characters after normalisation; blank or `null` means none (P2-07). */
  displayName?: string | null;
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

/**
 * `POST /api/v1/auth/verification/confirm` request body (backlog P2-04, ADR-0021). `token` is the
 * secret from the emailed link (`…/auth/verify-email#token=…`); the link keeps it in the URL
 * fragment, so it never reaches a server log or a `Referer` header.
 */
export interface ConfirmEmailRequest {
  token: string;
}

/**
 * `POST /api/v1/auth/verification/confirm` — 200 once the address is verified. An unknown,
 * expired, already used or superseded token gets 400 `INVALID_TOKEN` — the same for every cause.
 */
export interface EmailVerifiedResponse {
  status: 'verified';
}

/**
 * `POST /api/v1/auth/verification/resend` — 202 (signed in). A new link is emailed unless the
 * address is already verified; earlier links stop working. Too soon or too often → 429
 * `RATE_LIMITED` with `details.policy` `verification-email`.
 */
export interface VerificationEmailAcceptedResponse {
  status: 'accepted';
}

/** `POST /api/v1/auth/password-reset/request` request body (backlog P2-05, ADR-0022). */
export interface PasswordResetRequest {
  email: string;
}

/**
 * `POST /api/v1/auth/password-reset/request` — 202, identical for every well-formed address
 * (registered, unknown, deleted, or asked for too often), and answered before any lookup, so
 * neither the body nor the timing says whether an account exists. A registered address gets a
 * reset link at most once a minute and 5 times an hour.
 */
export interface PasswordResetAcceptedResponse {
  status: 'accepted';
}

/**
 * `POST /api/v1/auth/password-reset/confirm` request body (P2-05). `token` is the secret from the
 * emailed link (`…/auth/reset-password#token=…`, in the URL fragment); `password` must meet the
 * same policy as registration.
 */
export interface PasswordResetConfirmRequest {
  token: string;
  password: string;
}

/**
 * `POST /api/v1/auth/password-reset/confirm` — 200 once the new password is set. Every session of
 * the account has been ended (sign in again with the new password; this response does not sign
 * in) and the address counts as verified. A dead link → 400 `INVALID_TOKEN`; a password that
 * breaks the policy → 400 `VALIDATION_FAILED` (the link stays usable).
 */
export interface PasswordResetResponse {
  status: 'password-reset';
}
