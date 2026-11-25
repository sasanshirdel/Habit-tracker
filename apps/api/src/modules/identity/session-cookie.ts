import type { IncomingMessage, ServerResponse } from 'node:http';
import { SESSION_ABSOLUTE_LIFETIME_MS, SESSION_COOKIE_NAME } from './identity.constants.js';

/**
 * Reading and writing the session cookie (backlog P2-02, ADR-0018) without a cookie-parsing
 * dependency: the API reads exactly one cookie.
 *
 * Attributes: `HttpOnly` (no script access), `Secure` (required by the `__Host-` prefix; browsers
 * also accept it on `http://localhost` for development), `SameSite=Lax` (not sent on cross-site
 * POST/fetch — the CSRF baseline until P2-03 adds explicit CSRF checks), `Path=/`, no `Domain`.
 */

/** The session cookie's value from the request, or `undefined` (absent, empty, or not ASCII-safe). */
export function readSessionCookie(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 && value.length <= 256 ? value : undefined;
  }
  return undefined;
}

function serialize(value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/** Sets the cookie for a new session token (base64url, so no encoding is needed). */
export function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader('Set-Cookie', serialize(token, Math.floor(SESSION_ABSOLUTE_LIFETIME_MS / 1000)));
}

/** Tells the browser to delete the cookie (same attributes, `Max-Age=0`). */
export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', serialize('', 0));
}
