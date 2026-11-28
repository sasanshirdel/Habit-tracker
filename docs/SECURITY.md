# Security

Security is a first-class requirement (PRD §4, §17). This document is the working security model;
ADR-0005 records the identity design. Anything here that is not yet implemented is marked with the
phase that delivers it.

## Reporting a vulnerability

Do **not** open a public issue. Use GitHub's private vulnerability reporting ("Security" tab →
"Report a vulnerability") on this repository, or contact the owner directly. Include steps to
reproduce and impact. We aim to acknowledge within 3 business days.

## 1. Identity domains

|                | Customer                         | Administrative                                                                    |
| -------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| Table          | `User`                           | `AdminIdentity` (separate; no link that confers privileges)                       |
| App / origin   | `apps/web`                       | `apps/admin` on its own origin (Phase 10)                                         |
| API surface    | `/api/v1/*`                      | `/api/v1/admin/*` only                                                            |
| Session cookie | `__Host-session`, `SameSite=Lax` | `__Host-admin_session`, `SameSite=Strict`, short idle + absolute timeout          |
| MFA            | Optional (later)                 | **Mandatory**; owner requires passkey/WebAuthn, TOTP + recovery codes as fallback |

- The owner uses a **dedicated admin identity/email**. The owner's customer account (if any) has no admin rights. There is no "isAdmin" flag on `User`.
- Customer guards reject admin sessions and admin guards reject customer sessions.

## 2. Owner bootstrap (no default credentials)

There are **no default, seeded, hardcoded or environment-provided admin credentials** — ever. The
first Owner is created once, by an operator with shell access to the server (Phase 10):

1. Operator runs `pnpm --filter @habit/api admin:bootstrap-owner --email <owner-admin-email>` on the deployed environment.
2. The command **refuses** if any Owner already exists (idempotent, cannot be used to take over).
3. It creates a pending `AdminIdentity` with role Owner and prints a **single-use enrolment link** (random ≥128-bit token, stored hashed, expires in ≤30 minutes) to the operator's terminal only — never logged, emailed or stored in plaintext.
4. Opening the link forces: set a strong password, register a passkey (required), optionally TOTP, and download recovery codes. Until enrolment completes the identity cannot log in.
5. An audit record is written (`admin.owner.bootstrap`), including host and operator context.
6. Lost-owner recovery: documented break-glass procedure using recovery codes; failing that, the same CLI with an explicit `--recover` flag that requires database-level operator access and is audited. Never via the web UI.

Additional admins are invited by the Owner/Super Admin from the admin app (step-up required), with the same enrolment flow.

## 3. Authorisation (RBAC)

- Roles: Owner, Super Admin, Billing Admin, Support Admin, Content Admin, Read-Only Analyst → fine-grained permissions (e.g. `users.read`, `users.suspend`, `billing.refund.create`, `plans.write`, `ai.config.write`, `audit.read`). Least privilege; Super Admin is not the default for staff.
- **Every** admin endpoint checks: authenticated admin session · valid/unrevoked session · required permission · resource scope. Implemented as Nest guards + decorators; covered by an authorization test matrix (role × endpoint) in CI. Frontend route protection is cosmetic only.
- **Customer data** is owner-scoped: every query filters by the authenticated `userId`; cross-tenant access tests for each module.
- **Support access** to sensitive user content (journal, private goals) requires a purpose-bound, time-limited, audited grant; content is not casually visible to admins.

## 4. Sensitive operations (step-up)

Require fresh re-authentication (passkey/TOTP within the last few minutes) and explicit confirmation:
changing owner identity · MFA settings · payment credentials · security settings · creating/promoting
privileged admins · deleting critical data · high-value refunds · critical billing configuration.
These operations also require a trusted online connection (never queued offline).

## 5. Sessions, cookies, CSRF

- Opaque, random session IDs; stored hashed server-side; rotated at login and privilege change; revocable individually and "sign out everywhere".
- Cookies: `__Host-` prefix, `Secure`, `HttpOnly`, `Path=/`, appropriate `SameSite`.
- CSRF (P2-03, ADR-0019): two layers on every state-changing method (anything but GET/HEAD/OPTIONS). (1) `Origin` must equal one of `CORS_ORIGINS` exactly (`null`, other subdomains, ports or schemes are rejected); without `Origin`, `Sec-Fetch-Site` must be `same-origin`; non-browser requests without either pass this layer — applied to public routes too (stops login CSRF). (2) With a session, `X-CSRF-Token` must equal HMAC-SHA256(session token, "habit/csrf/v1") — stateless, rotates with the session, delivered only in the bodies of `POST /auth/login` and `GET /auth/session`, never in a cookie (no cookie tossing from sibling subdomains). Failures → 403 `CSRF_FAILED`, logged by reason only. The web client keeps the token in memory and retries once after `CSRF_FAILED`. `GET` handlers must never change state. **`CORS_ORIGINS` is also the CSRF trust list — list only origins we fully control.**
- Authentication is deny-by-default (P2-03): a global guard answers 401 `UNAUTHENTICATED` on every route not explicitly `@Public()`; a route-inventory test keeps the public list reviewed. Customer-owned rows are always queried with `ownedBy(user)`; another user's row answers 404, never 403.
- The browser never stores tokens or session identifiers in `localStorage`/`sessionStorage`; the web API client relies on cookies only (`credentials: 'include'`, tested).
- **Web auth pages (P2-09, ADR-0020):** sign-in/sign-up keep credentials only in form state and send them to the API alone; the CSRF token from sign-in lives in memory; sign-out drops cached queries only after the API confirmed. `(app)` page protection is **client-side UX** (`AuthGate` on `GET /auth/session`) because the session cookie lives on the API origin — server-rendered pages must never contain user data, the API stays the authority. The `next` redirect parameter is honoured only for in-app section paths (no open redirect: no `//host`, schemes, backslashes, control characters, other origins). Error messages never reveal whether an account exists (one `INVALID_CREDENTIALS` text, neutral 202 copy). zod runs `jitless` in browsers so the CSP needs no `'unsafe-eval'`. A 401 from any app request re-checks the session; when it has ended, every cached query is dropped before the user is sent to sign-in (ADR-0027), so a different account signing in on that tab never sees the previous user's data. Server validation errors are mapped to fields by issue code; the API's own messages are never shown and never contain the rejected value (ADR-0009).
- Passwords: Argon2id; rate limiting + progressive lockout on login, recovery, MFA and verification endpoints; generic error messages (no account enumeration).
- **Email/password sign-in (P2-02, ADR-0018):** Argon2id via Node's built-in `crypto.argon2` (m=19 MiB, t=2, p=1 — OWASP minimum; PHC strings; re-hashed at sign-in when parameters change; at most 2 concurrent hashes per process, 503 when saturated). Passwords 8–128 code points after NFKC, no composition rules. Registration answers 202 identically for new, taken and soft-deleted addresses (hash computed on every path; no session issued). Sign-in runs one Argon2id verification on every path (dummy hash for unknown/deleted/password-less accounts) and answers every failure with the same 401 `INVALID_CREDENTIALS` — identical bodies and comparable latency are integration-tested. Brute force: `auth` class per address plus a progressive per-email lockout (5 failures → 1 min, doubling to 15 min; keyed by a hash of the submitted address whether or not it is registered; 429 `RATE_LIMITED`, `policy: "login-account"`; fails closed). Cookie `__Host-session` (`HttpOnly; Secure; SameSite=Lax; Path=/`), 30-day absolute / 7-day idle lifetime, rotated at sign-in; sign-out and sign-out-everywhere revoke server-side. CSRF checks and the deny-by-default guard landed with P2-03 (see the CSRF bullet above); the same-site (sibling subdomain) residual risk ADR-0018 named is closed by the exact-origin check and the session-bound token.
- **Email verification (P2-04, ADR-0021):** links carry a 256-bit token (SHA-256 stored), valid 24 h, once, for the address it was sent to, and only while it is the account's newest link; every bad link answers the same 400 `INVALID_TOKEN`; concurrent use is race-safe. The token travels in the URL **fragment** (never sent to servers, so never in access logs or `Referer`); the page removes it from the address bar and verifies only on a button press (POST, origin-checked) — link scanners that open URLs change nothing. Tokens and addresses are never in job payloads (`{ userId, reason }` only — the worker issues the token) or logs. The public sign-up form triggers at most one email per account per 15 minutes; resend is signed-in only, 1/min and 5/h per account (fails closed). Development transports only (`log`, file `outbox` with owner-only permissions) — no real email is sent until a provider is chosen. Unverified accounts may sign in (interim); routes that need a confirmed address use `@RequireVerifiedEmail()` (403 `EMAIL_NOT_VERIFIED`).
- **Password recovery (P2-05, ADR-0022):** `POST /auth/password-reset/request` answers the same 202 for every well-formed address **before** any lookup — the per-address limit (1/min, 5/h, keyed by a hash of the address, counted for unknown addresses too, fails closed, never a 429), the account lookup (deleted accounts get nothing) and the enqueue (`{ userId }` only) run after the response, so neither the body nor the timing reveals an account; the `auth` class (per client address) still applies. Reset links: 256-bit token (SHA-256 stored), **30 minutes**, single use, bound to the address, newest link only, token in the URL fragment and posted only on a button press; every dead link is 400 `INVALID_TOKEN`. `POST /auth/password-reset/confirm` checks the shared password policy (a violation keeps the link usable), hashes with Argon2id only for a usable link, and in one transaction consumes the token (race-safe), stores the hash, revokes **every** session (`password_changed`), deletes other reset links and marks the address verified; then it clears the sign-in lockout of the address and emails a "your password was changed" notice. It does not sign in. Tokens, passwords and addresses are never logged or put in job payloads.
- **Session management and security events (P2-08, ADR-0023):** users list their active sessions and revoke one or all others (`/account/sessions…`, protected, CSRF, owner-scoped — another user's session id is 404); a revoked session fails its next request (no session cache). Sessions store only a coarse client description (browser family, OS family, device class) derived from the User-Agent at sign-in — **no raw user agent, version, IP address or location**. Customer security events (`sign_in`, `sign_out`, `signed_out_everywhere`, `signed_out_other_sessions`, `session_revoked`, `password_reset`, `email_verified`) are written in the same transaction as the change, carry no personal data beyond the coarse client description, are shown to the user, and are kept 180 days (ended sessions 30 days), purged per account on write and daily for every account by the scheduled `identity.retention-cleanup` job (ADR-0026), which also deletes expired emailed-link tokens.
- **Profile and preferences (P2-07, ADR-0024):** `/account/profile` and `/account/preferences` are protected, CSRF-checked on `PATCH`, and address only the caller's own rows (no id in the URL; unknown fields such as `userId` are a 400). Display names are NFKC-normalised and may not contain control characters or bidirectional override/isolate characters (spoofing); `displayName`/`fullName`/`firstName`/`lastName` are redacted log keys. These fields are not security-relevant, so no security event is recorded. Avatar upload (file sniffing, size limits, private bucket, signed URLs) is deferred until the storage decision.
- **Data export and account deletion (P2-10, ADR-0025):** `POST /account/export` (signed in, CSRF, rate-limit class `sensitive`: 10/h per user, fails closed) returns all of the caller's rows as one JSON attachment built in a read-only snapshot; it contains no secrets (no password hash, session or link token hash), is never stored, cached or logged, and records a `data_exported` event. `POST /account/deletion` re-authenticates with the current password (403 `REAUTHENTICATION_FAILED`; failures count towards the sign-in lockout of the address; class `sensitive`), then in one transaction soft-deletes the account, revokes **every** session (`account_deleted`), deletes unused emailed links and records `account_deletion_requested`; the cookie is cleared. A deleted account cannot sign in (same 401 as an unknown address), reset its password or verify; its address stays reserved. The confirmation email carries a restore link (256-bit token, SHA-256 stored, newest only, fragment, button POST, valid until the purge); `POST /auth/account-restore` (public, `auth` class) restores within the 30-day grace period without signing in. `identity.account-purge` hard-deletes accounts past the grace period (cascade to every user-owned table — a catalog test enforces `ON DELETE CASCADE` and an export decision for every table referencing `users`); runs daily at 23:30 UTC from a worker-registered BullMQ job scheduler (ADR-0026). What the purge does not reach (logs with ids only, short-lived Redis counters, 7-day failed jobs with ids only, backups) is listed in ADR-0025.
- Storage (P2-01, ADR-0017): session cookies and emailed links carry a 256-bit random token; the database keeps only its SHA-256 hash (32 bytes, unique, enforced by CHECK), so a database copy yields no usable session or link. Password hashes are accepted by the database only as Argon2id PHC strings. Malformed tokens are rejected before any lookup and treated exactly like unknown ones; in-memory hash comparisons are constant time (`secretTokenHashesEqual`). Email addresses are `citext` and stay reserved while an account is soft-deleted.

## 6. Audit logging

Append-only `AdminAuditLog` (and security events for customers: login, password/MFA change, export,
deletion — the customer-facing event log exists since P2-08, ADR-0023: no IP or user agent, 180-day
retention; it is the user's own activity view, not the append-only admin audit log). Fields: actor, action, target, timestamp, before/after metadata (redacted), request context
(IP, user agent, request ID), outcome. The application DB role has INSERT/SELECT only on audit tables;
no admin UI can edit or delete entries. Retention defined before launch.

## 7. Secrets management

- Never commit secrets. `.gitignore` excludes `.env*` except `.env.example`, which holds **placeholders only**.
- Local: `.env` (developer machine only). CI: GitHub Actions secrets/environments (none needed in Phase 0). Staging/production: the hosting platform's secret manager (decision pending).
- Secrets are read server-side only. `NEXT_PUBLIC_*` variables must never contain secrets.
- Never return secrets in API responses or render them in admin UI (show "configured / last 4 / rotated at").
- Provider credentials stored in the DB (e.g. per-provider payment config) are encrypted with envelope encryption (KMS-managed key) — Phase 9/10.
- Logs redact passwords, tokens, cookies, authorization headers, payment data and journal content (P1-07, ADR-0010): every API/worker log line is JSON written by one logger that masks sensitive keys at any depth (passwords, secrets, tokens, authorization, cookies, sessions, API keys, card/IBAN data, journal/free-text content, AI prompts, email/phone) and credentials inside strings (URL credentials, Bearer/Basic, JWTs, `token=`-style pairs); error **messages** are dropped outside `NODE_ENV=development` (stack frames and codes kept); the access log records route pattern, status and duration only — never headers, cookies, query strings or bodies. Redaction is a safety net: never log bodies, payloads or user content on purpose — tested by unit, e2e and worker integration tests.
- Env validation fails fast and never echoes values (tested in `apps/api/src/config/env.test.ts`).
- Agents and CI use sandbox credentials only; no production credentials in development.
- **Database credentials** come only from `DATABASE_URL` (validated, never logged or returned; readiness responses carry no connection details or driver errors — tested). Prisma query/parameter logging is disabled.
- **Error responses (P1-05):** every failure is rendered by one global filter as `{ error: { code, message, details?, requestId } }`; stack traces, framework/driver messages and rejected input values never reach the client (any environment — tested). Unexpected errors are logged server-side as one structured line with the request id (P1-07). Client-supplied `x-request-id` values are accepted only in a strict format (no injection into logs/headers).
- **Security headers, CORS and rate limiting (P1-08, ADR-0011):** every API response carries a
  deny-all CSP (`default-src 'none'; frame-ancestors 'none'`), HSTS, `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, COOP/CORP and `Cache-Control: no-store`. Web documents get a
  per-request **nonce CSP** from `apps/web/proxy.ts` (no inline or injected scripts, no `eval` in
  production, no framing, `connect-src` limited to self + the API origin) and static headers (HSTS,
  `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` with sensors/payment off) from
  `next.config.ts`. CORS: only exact `CORS_ORIGINS` get CORS headers (credentials, explicit methods
  and request headers, nothing reflected); other origins get none. Rate limiting: a global guard with
  Redis counters — `default` 300/min per user-or-address on every route, `auth` 10/5 min per address
  (fails **closed** with 503 when Redis is down), `expensive` 20/h; 429 `RATE_LIMITED` with
  `Retry-After`. Counter keys hold a hash of the address, never the raw IP. The client address is
  the socket address unless `TRUST_PROXY` hops are configured — set it exactly behind a load
  balancer, never higher (spoofable `X-Forwarded-For`). New credential/code endpoints must use
  `@RateLimit('auth')`.
- **CSP enforced in a real browser (P1-13, ADR-0015):** the Playwright suite fails on any CSP
  violation, `console.error` or uncaught error on every page it visits, and proves that an injected
  inline script and inline event handler never run and that `fetch` to a foreign origin is refused,
  while the app's nonce'd scripts hydrate and the API origin stays reachable (CORS with credentials).
  E2E fixtures use no credentials; the CI job uses throwaway service-container passwords only.
- **UI primitives and the CSP (P1-09, ADR-0013):** fonts are self-hosted (`font-src 'self'`, no font
  CDN at runtime or build time); primitives inject no `<style>` without the request's nonce
  (`UiProvider` hands it to the modal scroll lock; sonner was rejected for injecting un-nonced
  styles); themes need no inline script (server-rendered from the `theme` cookie, whose value is
  validated against a fixed list).
- **API documentation (P1-06, ADR-0012):** the OpenAPI document is JSON only at
  `/api/docs/openapi.json` (no HTML UI, which the API CSP would block anyway). It is **off when
  `NODE_ENV=production`** (production and staging) unless `API_DOCS_ENABLED=true` is set explicitly,
  which logs a warning; disabled, the path answers 404 `NOT_FOUND`. It is generated from the zod
  schemas, contains no configuration or connection details (tested), and is not rate-limited
  (cached, read-only). **Admin routes (`/api/v1/admin/*`) must be `@ApiExclude()`d** — the generator
  refuses to build a document that would publish one, so admin endpoints never appear in it.
- **Redis and background jobs (P1-03):** the Redis URL comes only from `REDIS_URL` (validated, never logged; connection errors are logged as error codes, once per outage — tested). Redis must never be reachable from the internet: docker-compose binds it to `127.0.0.1`; staging/production must keep it on a private network with authentication (`rediss://` + ACL user) — to be enforced with deployment (P12-06). **Job payloads carry identifiers and small parameters only**, never personal or sensitive content (journal text, emails, tokens): payload schemas are strict (`z.strictObject`), validated by the producer and again by the worker, and payloads are never logged (failures log job name, id, attempt and an error code). Handlers must re-check authorization/ownership against the database rather than trust a payload.
- **Database roles (least privilege):** the docker-compose and CI users are local/ephemeral superusers for convenience only. Staging/production must use two roles: a _migration_ role that owns the schema and runs `prisma migrate deploy`, and a _runtime_ role for the API/worker with only `CONNECT` + `USAGE` on the schema and `SELECT/INSERT/UPDATE/DELETE` on tables (no DDL, no `CREATE DATABASE`, not superuser). Append-only tables (audit logs, Phase 10) additionally revoke `UPDATE/DELETE` from the runtime role. To be implemented with deployment (P12-06).

## 8. Application security controls

| Control                                                                          | Status                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Input validation at API edge (DTO schemas)                                       | Phase 1 (env validation done in Phase 0)                |
| API docs off in production; admin endpoints never documented                     | **Done (P1-06)** — tested                               |
| Output encoding / XSS (React escaping, CSP)                                      | **Done (P1-08)** — nonce CSP + security headers, tested |
| `X-Powered-By` removed                                                           | **Done (Phase 0)** — tested                             |
| SQL injection (Prisma parameterisation; raw SQL reviewed)                        | Phase 1+ (only raw SQL so far: readiness `SELECT 1`)    |
| Rate limiting & brute-force protection (Redis-backed)                            | **Done**: baseline (P1-08), login lockout (P2-02)       |
| Re-authentication for account deletion; data export; erase after grace period    | **Done (P2-10)** — purge scheduled daily (ADR-0026)     |
| CORS allow-list from env                                                         | **Done (Phase 0)**; hardened + tested (P1-08)           |
| Secure file uploads (type/size checks, private S3, signed URLs)                  | Phase 2 (avatar)                                        |
| Webhook signature verification + idempotency                                     | Phase 9                                                 |
| Dependency scanning (`pnpm audit`, Dependabot/Renovate), secret scanning, CodeQL | Backlog (Phase 1)                                       |
| pnpm `allowBuilds` allow-list + minimum release age for install scripts          | **Done (Phase 0)**                                      |
| Encryption in transit (TLS everywhere), at rest (managed DB/S3 encryption)       | Phase 12 deployment                                     |
| Backups with tested restore                                                      | Phase 12                                                |
| Security monitoring & alerting                                                   | Phase 10–12                                             |

## 9. AI and privacy

- AI provider keys are server-side only. AI reads journal/private data only with explicit user opt-in.
- AI tools enforce the same authz as the API; any data-changing action requires user confirmation (or an explicit, limited automation permission).
- Data minimisation, export and account deletion are product requirements. Export, deletion with a 30-day restore window and the purge exist since P2-10 (ADR-0025, see §5); every new module with user rows must register its export section and cascade from `users`. A jurisdictional privacy/tax/payment review is required before commercial launch.

## 10. Pre-production gates

Before production (Phase 10/12): explicit authorization review of every endpoint, penetration-style
test of auth/admin/payment flows, dependency audit clean or risk-accepted, backup-restore rehearsal,
secrets rotation plan, incident response runbook.
