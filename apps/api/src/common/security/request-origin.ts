import type { IncomingMessage } from 'node:http';

/**
 * First CSRF layer (backlog P2-03, ADR-0019): where did a state-changing request come from?
 * Applied by the `AuthGuard` to every unsafe method on every route — public ones (sign-in,
 * registration) included — before any session is looked up.
 *
 * Browsers send `Origin` on every `POST`/`PUT`/`PATCH`/`DELETE`, same-origin or not, and modern
 * ones also send `Sec-Fetch-Site`. Rules:
 * 1. `Origin` present → it must be exactly one of the trusted origins (`CORS_ORIGINS`), else
 *    rejected. `Origin: null` (sandboxed frames, some redirects) is never trusted.
 * 2. No `Origin` but `Sec-Fetch-Site` present → only `same-origin` passes (a page of the API's own
 *    origin; the API serves no HTML, so in practice nothing).
 * 3. Neither header → not a browser request (curl, server-to-server, tests). Passes this layer;
 *    a session-carrying request still needs the session-bound token (second layer).
 *
 * Sibling subdomains: `SameSite=Lax` treats `evil.example.com` as the same *site* as
 * `app.example.com`, so the cookie alone does not stop it. Its `Origin` is not in the exact
 * allow-list, so rule 1 rejects it — this check compares origins, never sites or suffixes.
 */

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether a method may change state (everything except GET, HEAD, OPTIONS). */
export function isUnsafeMethod(method: string | undefined): boolean {
  return !SAFE_METHODS.has((method ?? 'GET').toUpperCase());
}

/** Why a request failed the origin check (logged; never shown to clients beyond the code). */
export type OriginRejection = 'origin-not-allowed' | 'origin-null' | 'cross-site-fetch';

export function checkRequestOrigin(
  req: Pick<IncomingMessage, 'headers'>,
  trustedOrigins: ReadonlySet<string>,
): OriginRejection | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') return 'origin-null';
    return trustedOrigins.has(origin) ? null : 'origin-not-allowed';
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '') {
    return site === 'same-origin' ? null : 'cross-site-fetch';
  }
  return null;
}
