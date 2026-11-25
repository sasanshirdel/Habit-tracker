# ADR-0011: Security headers, CORS and rate limiting

- **Status:** Accepted (Phase 1, backlog P1-08)
- **Date:** 2026-11-24

## Context

PRD §10 and SECURITY.md require security headers/CSP, an exact CORS allow-list and Redis-backed
rate limiting before protected functionality ships; registration and login (P2-02) depend on this
item. Until now the API only removed `X-Powered-By`, CORS was configured in `main.ts` only (so no
test exercised it) with the `cors` defaults for methods and headers (it reflects whatever headers a
preflight asks for), and the web app sent no security headers. Redis and the shared ioredis
connection exist since P1-03; the error envelope (`RATE_LIMITED` code included) since P1-05
(ADR-0009); structured logging since P1-07 (ADR-0010).

## Decision

### API headers — in-repo middleware, first in the chain

`securityHeadersMiddleware` (`apps/api/src/common/security/`) is the first middleware in
`configureApp`, so every response — success, error, 404, body-parse failure, 429 — carries:
`Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
(the API serves JSON, never documents), `Strict-Transport-Security: max-age=31536000; includeSubDomains`
(no `preload` until the launch domain is decided, P12), `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-site`, `Origin-Agent-Cluster`, `X-DNS-Prefetch-Control: off`,
`X-Permitted-Cross-Domain-Policies: none`, `X-Download-Options: noopen` and
`Cache-Control: no-store` (responses can carry personal data; a handler may set another policy
deliberately). The list is pinned by a unit test and asserted end-to-end.

### CORS — exact allow-list, nothing reflected

CORS moved from `main.ts` into `configureApp` (tested). A per-request delegate gives an origin in
`CORS_ORIGINS` the full options — credentials, methods `GET HEAD POST PUT PATCH DELETE`, request
headers `Accept, Accept-Language, Content-Type, X-Request-Id` (explicit, not reflected), exposed
headers `x-request-id` + rate-limit headers, preflight cache 10 min — and switches CORS **off**
for every other origin (no `Access-Control-*` header at all). `CORS_ORIGINS` entries are validated
URLs, so `*` is impossible with credentials. P2-03 adds the CSRF header to the allowed list.

### Rate limiting — global guard, named classes, Redis fixed windows

- `RateLimitModule` registers `RateLimitGuard` as the first global guard (imported before any
  module that adds an auth guard), so floods are limited before authentication work.
- Every routed request counts against **`default`** (300 / 60 s, per user once authenticated, else
  per client address). Routes add a stricter class with `@RateLimit('auth')` (10 / 5 min per
  address; login, registration, recovery, verification, MFA) or `@RateLimit('expensive')` (20 / h;
  exports, AI, reports); both budgets must allow the request. `@SkipRateLimit()` exempts health
  probes only. Numbers live in `rate-limit.policies.ts`, pinned by a test.
- **Store:** one atomic Lua script (`INCR`, `PEXPIRE` on the first hit, TTL repair) on the shared
  `RedisConnection`, keys `RATE_LIMIT_PREFIX:<policy>:<sha256(identity)[0..32]>`. Fixed windows keep
  it to one key and one round-trip per policy; the burst-at-window-edge weakness (up to 2× in a
  short span) is acceptable for these classes, and per-account lockout for credentials is P2-02's
  job on top. Identities are hashed so raw IPs are not stored — pseudonymisation, not
  anonymisation; keys expire with their window.
- **Responses:** every limited response carries `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset` (seconds; IETF draft fields) for the tightest policy. Over the limit: 429 with
  `Retry-After` and the ADR-0009 envelope `{ error: { code: 'RATE_LIMITED', message,
details: { retryAfterSeconds, policy }, requestId } }` (`RateLimitErrorDetails` in
  `@habit/shared-types`). The access log records the 429; the guard logs only at `debug`.
- **Redis unavailable:** the store fails fast when the connection is not ready and gives up after
  250 ms. Then each policy's `onStoreFailure` applies: `default`/`expensive` **fail open** (a Redis
  outage must not take the whole API down; readiness already reports Redis down), `auth` **fails
  closed** with 503 `SERVICE_UNAVAILABLE` (serving credential endpoints without a limit is the
  bigger risk). The outage is logged once, the recovery once.
- **Client address:** Express `trust proxy` = `TRUST_PROXY` hops (default 0: the socket address,
  `X-Forwarded-For` ignored — tested). Deployments behind a load balancer must set the real hop
  count (P12-06), otherwise all clients share the balancer's budget.
- 404s (no route) and CORS preflights are not counted (guards run only for matched routes).
- `RATE_LIMIT_ENABLED=false` disables the guard (local load testing only; it logs a warning).

### Web — per-request nonce CSP plus static headers

- `apps/web/proxy.ts` (Next 16's renamed middleware) creates a 128-bit nonce per document request
  and sets `Content-Security-Policy` on the response and the forwarded request; Next.js reads the
  nonce from the request header and adds it to its framework scripts. Production policy:
  `script-src 'self' 'nonce-…' 'strict-dynamic'` (no `unsafe-inline`, no `unsafe-eval`),
  `style-src 'self' 'nonce-…'` with `style-src-attr 'unsafe-inline'` (UI primitives position
  popovers with style attributes; attributes cannot execute code), `connect-src 'self'` + the API
  origin from `NEXT_PUBLIC_API_BASE_URL`, `object-src 'none'`, `frame-ancestors 'none'`,
  `base-uri`/`form-action 'self'`, `upgrade-insecure-requests`. Development adds `'unsafe-eval'`,
  inline styles and `ws:` for HMR only.
- Nonces need a per-request render, so the locale layout calls `connection()`: `/{locale}` pages
  are now dynamic instead of prerendered. Acceptable — the product is an authenticated app whose
  pages will be per-user anyway; public marketing pages that want CDN caching can move to hashes
  (Next's experimental SRI) later.
- `next.config.ts` `headers()` sets the static set on every path: HSTS, `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, COOP,
  `Origin-Agent-Cluster`, `X-DNS-Prefetch-Control: off`, `X-Permitted-Cross-Domain-Policies: none`
  and a `Permissions-Policy` that turns off camera, microphone, geolocation, payment, USB, serial,
  Bluetooth and topics until a feature needs one (voice journal, P5, will re-enable microphone for
  self).

## Alternatives considered

Checked against the npm registry on 2026-11-24 (UTC+03:30) with `npm view`:

- **helmet 8.3.0** (last modified 2026-07-12): the usual choice for the API headers. Not taken:
  its value for a JSON-only API is a fixed list of about a dozen headers, which we set in a
  20-line middleware pinned by tests; its defaults also target HTML responses (e.g. a CSP allowing
  `'self'` scripts) that we would override anyway. AGENTS.md: prefer no new dependency.
- **@nestjs/throttler 6.8.0** (2026-11-16; peers Nest `^7 … ^12`) **+ @nest-lab/throttler-storage-redis
  1.2.0** (2026-02-03; peers Nest `^7 … ^11` — **does not declare Nest 12**, our version). The
  throttler's in-memory default is per process (useless across instances), so Redis storage is a
  second package whose peer range excludes our Nest major. Its 429 also bypasses our error codes
  unless customised. Not taken; revisit if a maintained Redis storage supports Nest 12 and we need
  features beyond fixed windows.
- **rate-limiter-flexible 11.5.0** (2026-11-15): solid, many algorithms and stores. Not taken for
  now: our need is one atomic script on a connection we already own; revisit for sliding windows,
  penalties or blocking durations if P2-02's lockout needs them.
- **Sliding-window log / token bucket in Redis:** smoother than fixed windows but more keys or
  larger scripts; not needed for these limits.
- **CSP without nonces** (`'unsafe-inline'` scripts in `next.config.ts`): keeps static rendering
  but defeats the CSP's main purpose (blocking injected inline scripts), which the backlog item
  explicitly requires. Not taken.

## Consequences

- No new dependency (ADR-0001 addendum records the evaluation).
- New env vars: `RATE_LIMIT_ENABLED`, `RATE_LIMIT_PREFIX`, `TRUST_PROXY` (validated; documented in
  `.env.example`). Integration tests isolate counters under the run's key prefix.
- Every API route is rate-limited by default; a new public credential/code endpoint must add
  `@RateLimit('auth')`, and a costly one `@RateLimit('expensive')` (review checklist item).
- Web pages render per request. Inline `<script>` in our own code must use `next/script` with the
  nonce (read it from the `x-nonce` request header); third-party script origins need an ADR-level
  CSP change.
- CSP was verified against a production build (`next build && next start`: every `<script>` carries
  the per-request nonce); an in-browser CSP-violation check belongs in the Playwright smoke tests
  (P1-13).
- Follow-ups: P2-02 per-account progressive lockout + `@RateLimit('auth')` on its routes; P2-03 CSRF
  header in the CORS list; P12-06 `TRUST_PROXY`, HSTS `preload` decision and CSP reporting endpoint.
