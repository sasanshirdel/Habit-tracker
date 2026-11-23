import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface.js';
import { REQUEST_ID_HEADER } from '../request/request-context.js';

/**
 * Response headers for every API response (backlog P1-08, ADR-0011). The API serves JSON only —
 * never HTML, scripts or documents — so the policy is "nothing may load, nothing may frame":
 *
 * - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; …` — if a response is
 *   ever rendered as a document (opened directly, content sniffing), it cannot run or load
 *   anything and cannot be framed.
 * - `Strict-Transport-Security` — HTTPS only for a year, subdomains included. Browsers ignore it on
 *   plain-HTTP responses, so local development is unaffected. `preload` is a domain decision for
 *   launch (P12), not set here.
 * - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (legacy browsers), no referrer,
 *   cross-origin isolation of the response, no Flash/PDF cross-domain policies, no DNS prefetch.
 * - `Cache-Control: no-store` — API responses can carry personal data; nothing is cached by
 *   browsers or shared caches unless a handler deliberately sets another policy.
 *
 * Kept in-repo instead of `helmet`: a dozen fixed headers do not justify a dependency, and the
 * list is pinned by tests (see ADR-0011 for the comparison).
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // `same-site`, not `same-origin`: the web app (app.example) and API (api.example) are expected to
  // be same-site. CORP only affects no-cors loads; credentialed `fetch` is governed by CORS below.
  'Cross-Origin-Resource-Policy': 'same-site',
  'Origin-Agent-Cluster': '?1',
  'X-DNS-Prefetch-Control': 'off',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'X-Download-Options': 'noopen',
  'Cache-Control': 'no-store',
});

/**
 * First middleware of the app: sets {@link API_SECURITY_HEADERS} before anything else runs, so
 * they are present on every response — success, error, 404, body-parse failures and 429s.
 */
export function securityHeadersMiddleware(
  _req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) res.setHeader(name, value);
  next();
}

/** Rate-limit headers browsers may read cross-origin (the web app shows "try again in …"). */
export const RATE_LIMIT_EXPOSED_HEADERS = [
  'Retry-After',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
] as const;

/**
 * CORS for the browser app (P1-08 review of the Phase 0 allow-list):
 * - only the exact origins in `CORS_ORIGINS` (validated URLs; `*` is impossible) get CORS headers;
 *   see {@link corsDelegate} for other origins;
 * - credentials allowed (session cookies, Phase 2), which is why the list must stay exact;
 * - explicit methods and request headers (no reflection of whatever the client asks for);
 * - only `x-request-id` and the rate-limit headers are exposed to scripts;
 * - preflights cached for 10 minutes.
 */
export function corsOptions(origins: readonly string[]): CorsOptions {
  return {
    origin: [...origins],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Accept', 'Accept-Language', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: [REQUEST_ID_HEADER, ...RATE_LIMIT_EXPOSED_HEADERS],
    maxAge: 600,
    optionsSuccessStatus: 204,
  };
}

/**
 * Per-request CORS decision: an allowed `Origin` gets {@link corsOptions}; any other origin (or a
 * missing one) gets CORS switched off for that request — no `Access-Control-*` headers at all, not
 * even credentials/methods, so foreign pages learn nothing and the browser blocks the response.
 * Same-origin and non-browser clients (no `Origin`) are unaffected.
 */
export function corsDelegate(origins: readonly string[]): CorsOptionsDelegate<IncomingMessage> {
  const allowed = new Set(origins);
  const options = corsOptions(origins);
  return (req, callback) => {
    const origin = req.headers.origin;
    callback(null, typeof origin === 'string' && allowed.has(origin) ? options : { origin: false });
  };
}
