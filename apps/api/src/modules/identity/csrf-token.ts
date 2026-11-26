import { createHmac, timingSafeEqual } from 'node:crypto';
import { CSRF_HEADER_NAME } from '@habit/shared-types';

/**
 * Second CSRF layer (backlog P2-03, ADR-0019): a token bound to the session.
 *
 * `csrfTokenFor(sessionToken) = base64url(HMAC-SHA256(key = session token, "habit/csrf/v1"))`.
 *
 * - Stateless: nothing is stored; the server recomputes it from the cookie it receives.
 * - Bound to the session: it changes whenever the session does (sign-in rotation), and a token
 *   of one session is useless with another.
 * - Unforgeable without the session token (256-bit random, `HttpOnly`, never in a body or log),
 *   and it reveals nothing about it (HMAC is one-way). The database stores SHA-256(session token)
 *   — a different function — so a database copy yields no CSRF token either.
 * - Not readable by other origins: it is delivered only in response bodies of the sign-in and
 *   current-session routes, which CORS lets only the allowed web origins read. A sibling
 *   subdomain can neither read it nor plant it (no cookie involved, so cookie tossing does not
 *   apply — the classic weakness of plain double-submit cookies).
 *
 * The web client keeps it in memory only and sends it in {@link CSRF_HEADER} on every unsafe
 * request (ADR-0014).
 */

/** Request header carrying the token (case-insensitive on the wire). */
export const CSRF_HEADER = CSRF_HEADER_NAME;

const CONTEXT = 'habit/csrf/v1';

/** 32-byte HMAC → 43 base64url characters. */
export const CSRF_TOKEN_LENGTH = 43;

export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', Buffer.from(sessionToken, 'utf8'))
    .update(CONTEXT)
    .digest('base64url');
}

/** Constant-time comparison of a presented header value with the expected token. */
export function csrfTokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length !== CSRF_TOKEN_LENGTH) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
