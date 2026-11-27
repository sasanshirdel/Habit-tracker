# ADR-0019: CSRF protection and deny-by-default authentication

- **Status:** Accepted (P2-03)
- **Date:** 2026-11-26

## Context

ADR-0005 chose opaque server-side sessions in an `HttpOnly` `__Host-session` cookie and requires
CSRF protection for cookie-authenticated state-changing requests; SECURITY §5 allows "double-submit
token or Origin/`Sec-Fetch-Site` checks". ADR-0018 (P2-02) shipped sign-up/sign-in/sign-out with
`SameSite=Lax` as the only CSRF baseline and named the residual risk: **same-site requests from a
sibling subdomain** (`evil.example.com` is the same _site_ as `app.example.com`, so `Lax` cookies
travel). ADR-0014 left a `csrf` option in the web client for this item; ADR-0011 left the CSRF
header out of the CORS allow-list; ADR-0010 left `setRequestUserId()` for the guard. Backlog P2-03
(#23): a global CSRF strategy, `@CurrentUser()`, default-deny (protected unless marked public),
401 for unauthenticated access, an authz test-matrix scaffold, owner-scoping helpers.

Deployment shape assumed by earlier ADRs: web app and API on different origins of one site
(`app.example` / `api.example`, ADR-0011 CORP `same-site`, ADR-0015 tests cross-origin), or the
API behind the web origin at `/api/v1` (ADR-0014 fallback).

## Decision

### Deny by default: one global `AuthGuard`

- `IdentityModule` registers `AuthGuard` as an `APP_GUARD`. `AppModule` imports `RateLimitModule`
  first, so the rate limiter still runs before any authentication work (ADR-0011).
- **Every route is protected unless marked.** Markers are platform code (`src/common/auth`), so
  platform controllers (health) can use them without importing a feature module (ADR-0006/0016):
  - no marker → `required`: an active session or **401 `UNAUTHENTICATED`**;
  - `@Public()` → no session lookup at all (health probes, register, login);
  - `@Public({ session: 'optional' })` → served without a session, but a presented live session
    is resolved and CSRF-checked (logout).
- **Session rules** are `SessionService.resolve` (ADR-0018): not revoked, before the 30-day
  absolute expiry, used within the 7-day idle timeout, account not soft-deleted; `last_used_at`
  slides at most once a minute. A presented cookie that no longer opens a session is cleared in
  the 401 (`Max-Age=0`). The cookie keeps its absolute `Max-Age` (no re-issue on use): the server
  is the authority for idle expiry.
- Resolution happens **once per request** (`RequestSessionResolver`, cached per request object)
  and is shared with the rate limiter through the platform token `SESSION_RESOLVER`.
  `IdentityModule` is `@Global()` only to provide that token.
- The guard attaches the principal (`{ userId, sessionId }`, opaque ids only) for
  `@CurrentUser()` and calls `setRequestUserId()`, so every later log line carries `userId`.
  `@CurrentUser({ optional: true })` exists for optional routes; without `optional` the decorator
  throws 401 rather than hand `undefined` to code that assumed a user.
- **Owner scoping scaffold:** `ownedBy(user)` → `{ userId }` for the `where` of every query on a
  customer-owned row, and `foundOr404()` so another user's row answers **404 `NOT_FOUND`**, exactly
  like a missing one (no existence oracle; 403 is reserved for authorization decisions about
  things the caller may know exist, e.g. entitlements later).
- **Route inventory test** (`test/route-guards.e2e.test.ts`): enumerates every route registered in
  `AppModule`, asserts the set of public/optional routes equals a reviewed allow-list, and sends an
  unauthenticated request to every other route expecting 401. A new route is protected
  automatically; a new public route fails the test until the list (and so a reviewer) says so.

### CSRF: two layers, no new dependency

**Layer 1 — Origin / `Sec-Fetch-Site` (every unsafe method on every route, public included).**
Unsafe = anything but `GET`, `HEAD`, `OPTIONS` (safe methods must never change state — a review
rule). Browsers send `Origin` on every `POST`/`PUT`/`PATCH`/`DELETE`:

1. `Origin` present → must be **exactly** one of `CORS_ORIGINS` (string equality of
   scheme+host+port; never a suffix or site comparison). `Origin: null` is rejected.
2. No `Origin`, `Sec-Fetch-Site` present → only `same-origin` passes.
3. Neither → not a browser (curl, server-to-server); passes this layer.

Failure → **403 `CSRF_FAILED`** before any session lookup or password work. This also stops
**login CSRF** (signing a victim into the attacker's account), which session-bound tokens cannot
cover because there is no session yet.

**Layer 2 — session-bound token (unsafe methods whenever a session is resolved).**
`csrfToken = base64url(HMAC-SHA256(key = session token, "habit/csrf/v1"))`, sent by the client in
**`X-CSRF-Token`** and compared in constant time. Missing or wrong → 403 `CSRF_FAILED`.

- Stateless (recomputed from the cookie; nothing stored), rotates with the session (sign-in
  rotation), useless with any other session.
- Unforgeable without the 256-bit session token, and one-way, so it reveals nothing about it. The
  database stores SHA-256(token) — a different function — so a database copy yields neither
  sessions nor CSRF tokens. No new server secret is needed.
- Delivered **only in response bodies**: `POST /auth/login` (`csrfToken`) and the new
  **`GET /auth/session`** (`{ user, csrfToken }`, protected; 401 when signed out). Only allowed
  origins can read those cross-origin (CORS); a sibling subdomain can neither read nor plant it —
  there is no CSRF cookie, so cookie tossing (the weakness of plain double-submit cookies across
  subdomains) does not apply.

**Why both layers.** Layer 1 alone already defeats cross-site and sibling-subdomain browsers in
every current browser, but relies on header presence (old browsers, privacy extensions, unusual
proxies stripping `Origin`). Layer 2 is the OWASP "synchronizer token" defence in depth and keeps
protecting session routes if Layer 1 is ever weakened (e.g. a wrongly broad `CORS_ORIGINS`).
Neither defends against XSS on an allowed origin; the nonce CSP (ADR-0011) does.

**Sibling-subdomain risk (ADR-0018) — closed for the browser:** `evil.example.com` sends
`Origin: https://evil.example.com` (rejected by layer 1) and cannot obtain the token (layer 2).
`__Host-session` cannot be set or overwritten by a subdomain. Remaining operational rule:
**`CORS_ORIGINS` must list only origins we fully control** — any listed origin is trusted with
users' sessions.

### Rate limits

Unchanged classes (ADR-0011). `default` (and `expensive`) are now **keyed by user** on routes that
resolve a session (protected/optional) — the promised "per user once authenticated" — so users
behind one NAT no longer share a budget. Public routes, anonymous requests and state-changing
requests from untrusted origins (which will be rejected) are keyed by address, and the latter
without a session lookup, so a foreign page cannot spend a victim's budget. `auth` stays per
address. Cost: a request with a well-formed cookie costs one indexed session lookup before it is
counted (an unknown cookie is then counted by address).

### Errors, OpenAPI, CORS, logging

- New code **`CSRF_FAILED`** (403) in `API_ERROR_CODES`, with `apiErrors.CSRF_FAILED` in en/fa
  (enforced by the existing message test); 401 stays `UNAUTHENTICATED`. Both use the ADR-0009
  envelope.
- OpenAPI: `components.securitySchemes` `sessionCookie` (`apiKey` in cookie `__Host-session`) and
  `csrfToken` (`apiKey` in header `X-CSRF-Token`); every operation states `security` explicitly
  (`[]` public, `[{}, …]` optional, cookie (+ CSRF on unsafe methods) protected — the validator
  rejects an operation without it); 401 documented on protected routes, 403 `CSRF_FAILED` on
  unsafe ones. Generated from the same metadata the guard enforces.
- CORS allow-list gains `X-CSRF-Token` as a request header (ADR-0011).
- Logging: a CSRF rejection logs one info line `{ msg: 'csrf check failed', reason, method }`
  (`origin-not-allowed`, `origin-null`, `cross-site-fetch`, `token-missing`, `token-mismatch`) —
  never cookies, tokens or the origin value; the access line carries route and status. Tests
  assert neither the session token nor the CSRF token reaches the logs.

### Web client (ADR-0014)

`lib/api/api.ts` configures the client's `csrf` option: header `X-CSRF-Token`, token from an
in-memory store (`lib/api/csrf.ts`) that fetches `GET /auth/session` on first need and caches the
result (`null` when signed out); P2-09's sign-in/sign-out code calls `csrfTokens.remember()`. The
client now accepts an async token source and, on 403 `CSRF_FAILED`, forgets the token and retries
**once** (safe: the API rejected before doing anything). Never web storage.

## Alternatives considered

- **Origin/`Sec-Fetch-Site` only** — simplest, no client work; rejected as the only layer (see
  "Why both layers").
- **Double-submit cookie** (random CSRF cookie mirrored in a header) — the web origin cannot read
  a cookie set by the API's origin, so it would need a `Domain=` cookie readable across the site,
  which sibling subdomains can also set (cookie tossing). Rejected.
- **Signed double-submit with a server secret (HMAC of session id)** — equivalent strength but
  needs secret management (no secret manager decision yet). The session token itself is already a
  per-session 256-bit secret, so it is the HMAC key.
- **Stored synchronizer token per session** (a column) — needs a migration and a write at
  sign-in for no extra security over the derived token.
- **Libraries** (checked with `npm view` on 2026-11-26): `csrf-csrf` 4.1.0 (signed double-submit
  _cookie_, needs `cookie-parser`, cookie readable only on the API origin — see above); `csrf-sync`
  4.2.1 (synchronizer token stored in `express-session`, which we do not use; registry entry
  last modified 2025-05); `tiny-csrf` 1.1.6 (cookie-based, last modified 2025-02); `@fastify/csrf-protection`
  8.0.2 (Fastify only); `csurf` 1.11.0 — **deprecated/archived**. None fits opaque sessions in our
  own table plus a cross-origin web app. The in-repo code is ~60 lines over `node:crypto`, pinned by
  unit and matrix tests. No dependency added.
- **`SameSite=Strict`** — would break following a link into the app from email/other sites while
  signed in, and still does not stop same-site subdomains. Kept `Lax` (admin will use `Strict`,
  ADR-0005).
- **Per-route opt-in guards** (`@UseGuards(AuthGuard)`) — one forgotten decorator exposes a
  route. Rejected for deny-by-default.

## Open decisions (for the owner)

1. **Web route protection (`(app)` layout).** ARCHITECTURE promised a server-side session check in
   the `(app)` layout with P2-03. It is **not implemented**: with web and API on different origins
   the session cookie is host-only on the API origin (`__Host-` forbids `Domain`), so the Next.js
   server never receives it. Options: (a) client-side redirect using `GET /auth/session` (UX only;
   the API stays the authority) — fits P2-09, which adds the sign-in page to redirect to; (b)
   serve the API under the web origin (`/api/v1` reverse proxy, ADR-0014 fallback), then the
   layout can forward the cookie server-side. Recommendation: (a) now, revisit with the
   deployment decision (P12). The placeholder pages still show no user data.
2. **`CORS_ORIGINS` doubles as the CSRF trust list.** Intentional (one list of origins we own);
   the owner should treat edits to it as security changes.

## Consequences

- No new dependency, env var, table or migration.
- Every new route is protected by default; making one public needs `@Public()` and an edit to
  the reviewed list in `test/route-guards.e2e.test.ts`.
- State-changing requests from browsers need an allowed `Origin`, and with a session also
  `X-CSRF-Token`; non-browser clients with a session cookie need the token too (they can read it
  from `GET /auth/session`).
- `GET` handlers must never change state.
- Login response gains `csrfToken` (additive). New route `GET /auth/session`.
- P2-08 (session list) and P2-09 (auth pages) build on `@CurrentUser()`, `GET /auth/session` and
  `csrfTokens.remember()`. Admin (P10) gets its own guard and cookie; customer guards never accept
  admin sessions (ADR-0005).
