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
- CSRF: double-submit token or origin/`Sec-Fetch-Site` checks on all state-changing cookie-authenticated requests.
- Passwords: Argon2id; rate limiting + progressive lockout on login, recovery, MFA and verification endpoints; generic error messages (no account enumeration).

## 6. Audit logging

Append-only `AdminAuditLog` (and security events for customers: login, password/MFA change, export,
deletion). Fields: actor, action, target, timestamp, before/after metadata (redacted), request context
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
- **Redis and background jobs (P1-03):** the Redis URL comes only from `REDIS_URL` (validated, never logged; connection errors are logged as error codes, once per outage — tested). Redis must never be reachable from the internet: docker-compose binds it to `127.0.0.1`; staging/production must keep it on a private network with authentication (`rediss://` + ACL user) — to be enforced with deployment (P12-06). **Job payloads carry identifiers and small parameters only**, never personal or sensitive content (journal text, emails, tokens): payload schemas are strict (`z.strictObject`), validated by the producer and again by the worker, and payloads are never logged (failures log job name, id, attempt and an error code). Handlers must re-check authorization/ownership against the database rather than trust a payload.
- **Database roles (least privilege):** the docker-compose and CI users are local/ephemeral superusers for convenience only. Staging/production must use two roles: a _migration_ role that owns the schema and runs `prisma migrate deploy`, and a _runtime_ role for the API/worker with only `CONNECT` + `USAGE` on the schema and `SELECT/INSERT/UPDATE/DELETE` on tables (no DDL, no `CREATE DATABASE`, not superuser). Append-only tables (audit logs, Phase 10) additionally revoke `UPDATE/DELETE` from the runtime role. To be implemented with deployment (P12-06).

## 8. Application security controls

| Control                                                                          | Status                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Input validation at API edge (DTO schemas)                                       | Phase 1 (env validation done in Phase 0)                |
| Output encoding / XSS (React escaping, CSP)                                      | **Done (P1-08)** — nonce CSP + security headers, tested |
| `X-Powered-By` removed                                                           | **Done (Phase 0)** — tested                             |
| SQL injection (Prisma parameterisation; raw SQL reviewed)                        | Phase 1+ (only raw SQL so far: readiness `SELECT 1`)    |
| Rate limiting & brute-force protection (Redis-backed)                            | **Baseline done (P1-08)**; per-account lockout P2-02    |
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
- Data minimisation, export and account deletion are product requirements (Phase 2 / 12). A jurisdictional privacy/tax/payment review is required before commercial launch.

## 10. Pre-production gates

Before production (Phase 10/12): explicit authorization review of every endpoint, penetration-style
test of auth/admin/payment flows, dependency audit clean or risk-accepted, backup-restore rehearsal,
secrets rotation plan, incident response runbook.
