# Architecture

Status: Phase 0 baseline. Source requirements: [`PRODUCT_REQUIREMENTS.md`](PRODUCT_REQUIREMENTS.md) §5–§10, §18.
Decisions referenced as ADR-NNNN live in [`decisions/`](decisions/).

## 1. System overview

```
                ┌─────────────────────────────┐      ┌───────────────────────────┐
 Browser / PWA  │ apps/web (Next.js 16)       │      │ apps/admin (Phase 10)     │
 (en LTR, fa RTL)│ App Router, SSR/SSG, SW,   │      │ separate origin, admin    │
                │ IndexedDB sync queue (P8)   │      │ session + MFA             │
                └──────────────┬──────────────┘      └─────────────┬─────────────┘
                               │ HTTPS  /api/v1 (REST, cookies)     │ /api/v1/admin/*
                               ▼                                    ▼
                ┌───────────────────────────────────────────────────────────────┐
                │ apps/api (NestJS 12, modular monolith)                        │
                │  auth · users · habits · goals · tasks · planning · focus ·   │
                │  journal · analytics · insights · ai-coach · notifications ·  │
                │  accountability · billing/payments/entitlements · admin ·     │
                │  audit · system-health                                        │
                └──────┬──────────────────┬──────────────────────┬──────────────┘
                       │ Prisma           │ BullMQ producers     │ adapters
                       ▼                  ▼                      ▼
                 PostgreSQL 18       Redis 8  ◄── apps/worker   External: AI providers,
                 (system of record)  (queues,     (Phase 1)     payment gateways (IR + intl),
                                      rate limits,              email, web push, S3, Google
                                      cache)
```

- **Modular monolith** (ADR-0006): one deployable API, internally split into Nest modules with explicit public interfaces. A separate **worker** process (same codebase, Phase 1) consumes BullMQ queues for slow/retryable work (notifications, reports, analytics snapshots, AI calls, payment reconciliation).
- **Frontend** talks only to the versioned REST API. Server is authoritative for authz, entitlements, metrics, payments.
- **Admin** is a separate app and auth domain (ADR-0005).

## 2. Repository structure (current + planned)

| Path                         | Phase | Purpose                                                                                |
| ---------------------------- | ----- | -------------------------------------------------------------------------------------- |
| `apps/web`                   | 0     | Next.js App Router; `app/[locale]/…`, `lib/i18n` (next-intl routing, ICU messages)     |
| `apps/api`                   | 0     | NestJS; `src/modules/*`, `src/config`, `prisma/`                                       |
| `apps/worker`                | 1     | Worker process: BullMQ consumers (P1-03); runs `WorkerModule` from `@habit/api/worker` |
| `apps/admin`                 | 10    | Admin frontend on a separate origin                                                    |
| `packages/config`            | 0     | tsconfig presets, ESLint config                                                        |
| `packages/ui`                | 0→1   | Tokens, themes, shadcn/ui primitives on Radix (`styles.css` for Tailwind; ADR-0013)    |
| `packages/shared-types`      | 1     | API contract types (responses, error envelope)                                         |
| `packages/shared-validation` | 1     | zod 4 input schemas (locale, time zone, date)                                          |
| `packages/localization`      | 1     | Locale metadata: locales, direction, Intl tags                                         |
| `infrastructure/`            | 12    | Deployment, Docker images, scripts                                                     |

### 2.1 Dependency rules (enforced)

`pnpm lint` ends with `pnpm check:architecture` (CI job `verify`), which fails on any violation of
these rules; the graph itself lives in `packages/config/architecture/rules.js` (P1-15, ADR-0016).
Change both together.

- **Layers:** apps may depend on packages; packages never depend on or import apps. Apps do not
  depend on each other — the one exception is `apps/worker` → `@habit/api`, and only its
  `@habit/api/queue` and `@habit/api/worker` exports (ADR-0002). In particular the web app never
  imports API code and the API never imports web code; they share contracts only through
  `@habit/shared-types` and `@habit/shared-validation`.
- **Allowed workspace graph** (`@habit/config` is build tooling, allowed everywhere):

  | Package                    | May depend on                                                                         |
  | -------------------------- | ------------------------------------------------------------------------------------- |
  | `@habit/shared-types`      | —                                                                                     |
  | `@habit/localization`      | —                                                                                     |
  | `@habit/shared-validation` | `localization`                                                                        |
  | `@habit/ui`                | —                                                                                     |
  | `@habit/api`               | `shared-types`, `shared-validation`, `localization`                                   |
  | `@habit/worker`            | `api` (`/queue`, `/worker` only), `shared-types`, `shared-validation`, `localization` |
  | `@habit/web`               | `shared-types`, `shared-validation`, `localization`, `ui`                             |

  A new workspace package fails the check until it has an entry; no cycles between packages.

- **Entry points only:** a `@habit/*` import must be declared in the importer's `package.json` and
  name an entry of the target's `exports` (never `src/` or `dist/` paths); relative and `@/` imports
  never leave their own package.
- **API (ADR-0006):** feature modules (`src/modules/<name>/`, from Phase 2) are imported only through
  their `index.ts`, and every module has one. Platform areas (`common`, `config`, `data-export`,
  `database`, `health`, `mail`, `openapi`, `queue`, `rate-limit`) never import feature modules; only the
  composition root (`src/*.ts`) and `worker/` wire them in (the worker imports the identity
  module's `IdentityJobsModule` for its email jobs, P2-04). Prisma's generated client (`src/generated`) is imported
  only by `database/` and feature modules. Areas form layers: no cycles between them.
- **No runtime import cycles** between the files of any package (`import type` cycles are allowed).

## 3. Backend modules (PRD §5.4)

Grouped by roadmap phase:

| Area                  | Modules                                                                                                                 | Phase |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----- |
| Platform              | config, health, logging, errors, OpenAPI, rate limiting, mail (P2-04), data export (P2-10)                              | 1–2   |
| Identity              | identity (auth, users, profiles, preferences, sessions — one module for now, ADR-0017)                                  | 2     |
| Habits                | habits (one module for now: tables since P3-01, ADR-0028), schedule engine, versioning, occurrences, templates, streaks | 3     |
| Execution             | goals, tasks, planning                                                                                                  | 4     |
| Focus & journal       | focus, journal                                                                                                          | 5     |
| Intelligence          | analytics (deterministic metrics), insights, recommendations, experiments, reviews                                      | 6     |
| AI                    | ai-providers (abstraction), ai-coach (conversations, tools, confirmations, usage)                                       | 7     |
| Engagement            | notifications (in-app, web push, email), sync (offline ops)                                                             | 8     |
| Commerce              | plans, entitlements, subscriptions, payments (adapters), billing portal, coupons, refunds                               | 9     |
| Administration        | admin-auth, rbac, admin, support, audit-logs, feature-flags, system-health                                              | 10    |
| Social & integrations | accountability, integrations (Google Calendar/Tasks)                                                                    | 11    |

Rules: a module owns its tables; cross-module calls only through exported services; side effects via domain events/queues. The import rules are enforced by the architecture check (§2.1). Every module with user-owned rows references `users(id)` with `ON DELETE CASCADE` and registers a `UserDataContributor` (its section of the data export, P2-10, ADR-0025) — an integration test fails for a table referencing `users` without both.

## 4. Data architecture

- PostgreSQL is the system of record; Prisma 7 schema at `apps/api/prisma/schema.prisma`; models arrive with their owning phase. Conceptual entities: PRD §6.
- **Identity tables (P2-01, ADR-0017):** `users` (citext unique email incl. soft-deleted, `deleted_at`), `user_profiles`, `user_preferences` (locale, IANA timezone, theme), `user_password_credentials` (Argon2id PHC only), `user_sessions` and `user_tokens` (only SHA-256 hashes of 256-bit random tokens, unique, 32 bytes by CHECK), all owned by the `identity` module (`src/modules/identity`) and cascading from `users`. CHECK constraints Prisma cannot express are hand-written in the migration SQL. Since P2-08 (ADR-0023) sessions carry a coarse client description (`client_browser`/`client_os`/`client_device` enums; no raw user agent or IP) and `user_security_events` holds the user's security activity (180-day retention, ended sessions 30 days, purged per account on write and daily for all accounts by `identity.retention-cleanup`, ADR-0026; indexes `user_sessions(revoked_at)`, `(last_used_at)` for it). Since P2-07 (ADR-0024) `user_preferences` also has `calendar` (`gregorian`|`solar_hijri`) and `week_start` (`saturday`|`sunday`|`monday`), set from the registration language and backfilled the same way; the calendar is display-only (APIs keep UTC instants and ISO dates). Since P2-10 (ADR-0025) `users.deleted_at` drives account deletion: soft delete with a 30-day restore window (restore token purpose `account_restore`), then the `identity.account-purge` worker job deletes the `users` row and everything cascades (index `users(deleted_at)`); new security event types `data_exported`, `account_deletion_requested`, `account_restored`.
- **Access (P1-01):** `DatabaseModule` (`apps/api/src/database/`) provides a single `PrismaService` (Prisma 7 + `@prisma/adapter-pg`, pool connect timeout 5 s). `DATABASE_URL` is required and validated at boot. The API starts even when the database is down; `GET /api/v1/health` (liveness) never touches the DB, `GET /api/v1/health/ready` (readiness) runs a bounded `SELECT 1` and answers 503 when it fails. Prisma `query` events and Prisma's own error lines are not logged (they can carry personal data).
- **Migrations:** `apps/api/prisma/migrations/`, starting with an empty `…_baseline` migration that only establishes the history. `prisma migrate deploy` in CI/deployments, `prisma migrate dev` locally. CI job `integration · PostgreSQL + Redis` (P1-02) applies migrations to a Postgres 18.7 service container and runs `*.int.test.ts` against a throwaway database (incl. a schema-drift check) and a Redis 8.8.4 service container (per-run key prefix), then verifies teardown left nothing behind.
- Conventions (ADR-0006): UUIDv7 IDs, `timestamptz` UTC + user IANA timezone, occurrences keyed by local date + schedule version, money in integer minor units + currency, soft delete where restorable, `version` column for offline-editable entities, idempotency keys for retried writes, migrations only via `prisma migrate`.
- **Queues (P1-03):** BullMQ 6 on Redis 8. The API's `QueueModule` (`apps/api/src/queue/`) owns one shared ioredis connection, the `QueueProducer` and the Redis readiness check; jobs are typed `JobDefinition`s (`defineJob`: name `<module>.<action>`, queue, strict zod payload schema, options) defined by the module that owns the work. Producers fail fast (`QUEUE_UNAVAILABLE`) instead of buffering when Redis is down, and accept an idempotency `jobId`. Defaults: 3 attempts, exponential backoff from 1 s, failed jobs retained 7 days in the failed set. The worker process (`apps/worker`) boots `WorkerModule` (`apps/api/src/worker/`) as a Nest application context: one BullMQ `Worker` per queue with handlers (`JOB_HANDLERS`), payloads re-validated before handling (invalid/unknown → failed without retry), graceful drain on SIGTERM bounded by `WORKER_SHUTDOWN_TIMEOUT_MS`, then connections close; anything cut off is recovered as a stalled job. Keys are namespaced by `QUEUE_PREFIX` (default `habit:q`). Readiness (`/api/v1/health/ready`) checks PostgreSQL and Redis in parallel. Queues: `system` (P1-03) and `email` (P2-04, transactional email). **Recurring jobs (ADR-0026):** modules declare `defineSchedule({ id, job, cron, payload })` (five-field cron in UTC, payload validated at definition) and the worker's `JobScheduleRegistrar` registers `JOB_SCHEDULES` as BullMQ job schedulers in the background after start-up — creating missing or changed ones, leaving matching ones untouched, removing undeclared ones, re-checking hourly, retrying while Redis is down; every replica does this idempotently, so each run is one job (at least once; handlers idempotent). `JOB_SCHEDULES_ENABLED=false` turns registration off. Schedules: `identity.account-purge-daily` (23:30 UTC) and `identity.retention-cleanup-daily` (23:45 UTC).
- **Transactional email (P2-04, ADR-0021):** sent only by the worker. Platform area `apps/api/src/mail`: `Mailer` (adds sender, `Message-ID`, date; logs template/locale/message id only) over a `MailTransport` port with development/test adapters only — `log` (default), file `outbox` (`MAIL_OUTBOX_DIR`), `memory` (tests); no real provider yet (owner decision). `renderEmail` builds an escaped, accessible HTML + plain-text message per locale (`dir="rtl"` for Persian); links must be https (http on loopback). Feature modules own their templates (identity: verification link, "you already have an account" notice, password-reset link and "password changed" notice — P2-05; "account deleted" with the restore link — P2-10).
- **Habit tables (P3-01, ADR-0028):** owned by the `habits` module (`src/modules/habits`, no routes yet — P3-06): `habit_categories`, `habits` (immutable `type` of six, unit, tokens for icon/colour, local `starts_on`/`ends_on`, preferred time, `position`, `version`, `archived_at`, `deleted_at`), `habit_schedule_versions` (schedule `kind` with typed columns, target and grace days, valid for local dates `[effective_from, effective_to)`; overlaps impossible via `EXCLUDE USING gist`, extension `btree_gist`), `habit_occurrences` (what the user recorded for a habit on a local date — a value or a skip, unique per habit and day; statuses are computed, never stored), `habit_notes`, `habit_pauses` (`habit_id` null = vacation for all habits). Calendar days are `date` columns with the user's local ISO date (Solar Hijri only at display/input); every table cascades from `users` and is in the export section `habits`; children reference habits through `(habit_id, user_id[, habit_type])` composite keys, so cross-user references and type changes are refused by the database. Type-specific values and targets, schedule shapes, text and date bounds are CHECK constraints kept in step with `HABIT_LIMITS` in `@habit/shared-validation`.
- **Habit engine (Phase 3)** is the riskiest domain logic: schedule versions with effective dates → occurrence generation (pure, deterministic function of schedule version + date range + timezone + pauses/vacations) → completions → streaks/consistency. Built as a pure library with exhaustive and property-based tests.
- **Analytics (Phase 6):** metrics computed by deterministic SQL/TS; snapshots materialised by worker jobs; insights carry evidence, time range and confidence.

## 5. API design

- REST under `/api/v1`; OpenAPI 3.1 generated from the routes' zod schemas (`ZodValidationPipe` inputs + `@ApiDoc` response schemas, no `@nestjs/swagger`), served as JSON at `/api/docs/openapi.json` outside production (`API_DOCS_ENABLED`) and exported by CI as an artifact; admin routes must be `@ApiExclude()`d (ADR-0012, P1-06).
- Input validated at the edge with zod: `ZodValidationPipe(schema)` per `@Body`/`@Query`/`@Param` → 400 `VALIDATION_FAILED` with `details.issues[{ field, code, message }]` (ADR-0009, P1-05); never return Prisma entities directly.
- Error shape: `{ error: { code, message, details?, requestId } }`, rendered for every failure by the global `AllExceptionsFilter`; `code` is a stable `ApiErrorCode` localised by the client; no stack traces or framework/driver text in any environment.
- Every response carries `x-request-id` (accepted from the caller when well-formed, else a UUID), also available in-process via `currentRequestId()`.
- Lists: cursor (keyset) pagination `?limit=&cursor=` → `{ data, page: { nextCursor, hasMore, limit } }`; `?sort=-field,field` over whitelisted fields; explicit typed filter parameters (ADR-0009). Helpers in `apps/api/src/common/`.
- Auth via secure session cookies (ADR-0005). Email/password (P2-02, ADR-0018): `POST /auth/register` (202, identical for taken addresses), `/auth/login` (sets `__Host-session`; 401 `INVALID_CREDENTIALS` for every failure; per-email progressive lockout on top of the `auth` class), `/auth/logout`, `/auth/logout-everywhere`; Argon2id on Node's built-in `crypto.argon2`; credential input rules shared via `@habit/shared-validation`. Since P2-03 (ADR-0019): every route is **protected by default** by the global `AuthGuard` (401 `UNAUTHENTICATED` without an active session; `@Public()` / `@Public({ session: 'optional' })` from `src/common/auth` opt out, kept in a reviewed list by a route-inventory test); `@CurrentUser()` gives the principal; `ownedBy()`/`foundOr404()` scope customer-owned rows (another user's row → 404). CSRF: exact-`Origin`/`Sec-Fetch-Site` check on every unsafe method plus a session-bound `X-CSRF-Token` (HMAC of the session token, from `POST /auth/login` or `GET /auth/session`) → 403 `CSRF_FAILED`. OpenAPI declares `sessionCookie`/`csrfToken` security schemes on every operation. Email verification (P2-04, ADR-0021): registration queues `identity.verification-email` (`{ userId, reason }` only; the worker issues a 24 h single-use token — newest link only — and emails `…/{locale}/auth/verify-email#token=…`, or a notice for an already verified address; at most once per account per 15 min); `POST /auth/verification/confirm` (public, `auth` class, 400 `INVALID_TOKEN` for every bad link), `POST /auth/verification/resend` (signed in; 1/min and 5/h per account). Unverified accounts may sign in (interim); `@RequireVerifiedEmail()` → 403 `EMAIL_NOT_VERIFIED` for features that need a confirmed address; the principal carries `emailVerified`. Password recovery (P2-05, ADR-0022): `POST /auth/password-reset/request` (public, `auth` class, identical 202 answered before any lookup; per-address limit, lookup and `identity.password-reset-email` `{ userId }` run after the response), `POST /auth/password-reset/confirm` (public; token + new password; one transaction consumes the 30-minute single-use token, stores the Argon2id hash, revokes every session with `password_changed`, marks the address verified; then clears the sign-in lockout and queues `identity.password-changed-email`; no automatic sign-in). Session management (P2-08, ADR-0023): `GET /account/sessions` (active sessions, `current` marked, cursor-paginated), `DELETE /account/sessions/{id}` (404 for anything not an active session of the caller; the current one = sign-out), `POST /account/sessions/revoke-others`, `GET /account/security-events`; every sign-in, sign-out, revocation, password reset and email verification writes a security event in the same transaction. Profile and preferences (P2-07, ADR-0024): `GET`/`PATCH /account/profile` (display name: NFKC, single spaces, ≤ 100 code points, no control/bidi-override characters, blank clears) and `GET`/`PATCH /account/preferences` (locale, IANA time zone, theme, calendar, week start; strict non-empty partial), always the caller's own row, no security event (not security-relevant). Data export and account deletion (P2-10, ADR-0025): `POST /account/export` (CSRF, class `sensitive`; one JSON attachment built synchronously in a read-only repeatable-read snapshot from the `UserDataExportRegistry` that each module contributes a section to — platform area `src/data-export`), `POST /account/deletion` (`{ password }` re-authentication → 403 `REAUTHENTICATION_FAILED`; soft delete + revoke every session + delete unused links in one transaction; 202 `{ purgeAfter }`; queues `identity.account-deleted-email`), `POST /auth/account-restore` (public; emailed token, valid until the purge; no sign-in); worker job `identity.account-purge` (daily at 23:30 UTC, ADR-0026).
- Security headers on every response, exact CORS allow-list, and rate limits per user-or-address and route class (`default` on every route; `@RateLimit('auth' | 'expensive' | 'sensitive')` — `sensitive` since P2-10: 10/h per user, fails closed; `@SkipRateLimit()` for probes only) with Redis counters → 429 `RATE_LIMITED` + `Retry-After` (ADR-0011, P1-08). The web app sets a per-request nonce CSP in `apps/web/proxy.ts`, so its pages render dynamically.

## 6. Frontend architecture

- App Router with `[locale]` segment; `<html lang dir>` from locale (ADR-0004).
- i18n with next-intl (P1-10, ADR-0004): `proxy.ts` sets the nonce CSP, then negotiates the locale for unprefixed paths (cookie → `Accept-Language` → `defaultLocale` from `@habit/localization`, 307, same origin only); ICU messages in `apps/web/lib/i18n/messages/{en,fa}.json` with a CI parity test; named formats in `lib/i18n/formats.ts`; locale-aware `Link`/`redirect` from `lib/i18n/navigation.ts`. Physical left/right utilities fail lint.
- Server components by default; client components for interaction. Data layer (P1-12, ADR-0014): typed `fetch` client `lib/api/client.ts` (`credentials: 'include'`, timeout, `X-CSRF-Token` from an in-memory store fed by `GET /auth/session` with one retry on `CSRF_FAILED` (P2-03, ADR-0019), never web storage) → `ApiError` with the envelope's stable `code`; TanStack Query 5 with retry only for transient codes; errors shown with `useErrorMessage()` from `apiErrors.<CODE>` messages (every `API_ERROR_CODES` entry, enforced); standard loading/error/empty states (`Skeleton` + `aria-busy`, `QueryError`, `EmptyState`). Demo: `/{locale}/status`.
- Design tokens (`packages/ui`) → Tailwind theme via `@habit/ui/styles.css`; dark (default), light and system themes from a `theme` cookie rendered on the server (no flash); logical CSS only; self-hosted Inter/Vazirmatn; primitives (Button, Input, Skeleton, Dialog, DropdownMenu, Toast) wrapped by `UiProvider` for direction and the CSP nonce (P1-09, ADR-0013).
- Application shell (P1-11): the `app/[locale]/(app)` route group renders every signed-in-app page inside `components/shell/app-shell.tsx` — skip link, labelled `navigation` (sidebar at the inline start: icon rail from `md`, full from `lg`; bottom bar with four sections + "More" sheet below `md`), `banner` with language and theme switchers, and `main#main` (focused after each client-side navigation). Sections and their placement are data in `lib/navigation/sections.ts`; direction-bearing icons are flipped in RTL (`rtl:-scale-x-100`). The shell does no authorization. A server-side session check in the `(app)` layout is not possible while the API is on another origin (its host-only `__Host-session` cookie never reaches the Next.js server), so since P2-09 (ADR-0020) the layout wraps page content in `AuthGate`: content renders only after `GET /auth/session` said "signed in" (server HTML holds a placeholder), signed-out visitors are sent to `/{locale}/auth/sign-in?next=…` (in-app paths only). UX only — the API is the authority, and pages never contain user data. The banner's account menu signs out. Placeholder pages are `noindex`.
- Form server errors and session expiry (P2-09, ADR-0027): a `400 VALIDATION_FAILED` issue is shown on the matching form field (`lib/forms/server-errors.ts`, localized, `aria-invalid`/`aria-describedby`, focus on the first); any 401 `UNAUTHENTICATED` from the app's API client (except `GET /auth/session` itself) triggers one shared session re-check — signed out → cached data dropped, `AuthGate` redirects to sign-in with the page as `next` and back after signing in.
- Auth pages (P2-09, ADR-0020): `app/[locale]/auth/{sign-in,sign-up,verify-email,forgot-password,reset-password}` with their own layout (verify-email since P2-04, ADR-0021: reads the token from the URL fragment, confirms on a button press; forgot/reset-password since P2-05, ADR-0022: neutral request confirmation, reset link read from the fragment, new password posted on a button press; `VerifyEmailBanner` in `AuthGate` reminds unverified accounts and resends); React Hook Form + the shared `signIn/signUpCredentialsSchema` through `lib/forms/schema-resolver.ts`; session state in `lib/auth/session.ts` (`useSession`), actions in `lib/auth/actions.ts`, the open-redirect guard in `lib/auth/redirect.ts`; `@habit/ui` adds `Label`, `PasswordInput`, `Alert`.
- PWA (Phase 8): manifest, service worker, IndexedDB store + operation queue, background sync where supported; documented offline matrix.

## 7. Initial information architecture

Primary navigation (PRD §2.3), validated during Phase 1 design work:

| Desktop sidebar | Mobile bottom bar (≤5) | Route (`/{locale}/…`)                                                                                |
| --------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Overview        | Overview               | `/` (dashboard)                                                                                      |
| Habits          | Habits                 | `/habits`, `/habits/[id]`, `/habits/templates`                                                       |
| Goals           | — (via "More")         | `/goals`, `/goals/[id]`                                                                              |
| Tasks           | Tasks                  | `/tasks` (list / calendar / kanban views)                                                            |
| Planner         | Planner                | `/planner/day`, `/planner/week`, `/planner/matrix`                                                   |
| Focus           | —                      | `/focus`, `/focus/history`                                                                           |
| Journal         | —                      | `/journal`, `/journal/[date]`                                                                        |
| Insights        | —                      | `/insights`, `/insights/reviews`, `/insights/experiments`                                            |
| AI Coach        | —                      | `/coach`                                                                                             |
| Settings        | More                   | `/settings/{profile,preferences,security,notifications,privacy,billing,integrations,accountability}` |

Public: `/{locale}` landing, `/{locale}/pricing`, `/{locale}/auth/*`, `/{locale}/onboarding`. Admin: separate app.
Quick capture is a global action (keyboard shortcut / FAB), not a page.

**Implemented in P1-11** (shell + one placeholder page per section, no data):

- Overview is served at **`/{locale}/overview`** (interim), because `/{locale}` is the public landing page. P2-09 kept this (safest reversible choice): the landing page links to sign-up/sign-in, and a signed-in visitor opening sign-in goes straight to the overview; no session call on the landing page. Swapping the two is still open — ROADMAP "Outstanding decisions" #10.
- Top-level section routes exist (`/habits`, `/goals`, `/tasks`, `/planner`, `/focus`, `/journal`, `/insights`, `/coach`, `/settings`); the sub-routes in the table (`/habits/[id]`, `/planner/day`, `/settings/profile`, …) are added by the features that own them. Built so far: `/settings/profile` and `/settings/preferences` (P2-07, ADR-0024), `/settings/security` (P2-08), `/settings/privacy` ("Your data": export and account deletion, P2-10, ADR-0025), plus the public `/auth/account-deleted` and `/auth/restore-account` pages. Signed-in components format dates with the profile time zone and calendar (`useDateDisplay`, `lib/account/preferences.ts`); a saved language moves the page to that locale's route; the theme follows the account preference (cookie kept in step, so pages render it from the first byte). Unknown paths below a section return the localized 404.
- Mobile bottom bar: Overview, Habits, Tasks, Planner, **More**; "More" opens a sheet with Goals, Focus, Journal, Insights, AI Coach, Settings (Settings last).

## 8. Cross-cutting concerns

- **Security:** see [`SECURITY.md`](SECURITY.md).
- **Observability (PRD §10):** structured JSON logs with request IDs and redaction; error tracking; metrics for API latency, queues, payments, AI usage; health/readiness endpoints; uptime checks; alerting. Phase 1 lays the logging/request-ID foundation (P1-07, ADR-0010: `JsonLogger` installed as Nest's logger in API and worker — JSON lines with `requestId`/`userId` or `jobId`/`jobName`/`attempt`, one access line per request, mandatory redaction, `LOG_LEVEL`/`LOG_FORMAT`); Phase 12 completes monitoring.
- **Configuration:** zod-validated env at boot (`apps/api/src/config/env.ts`); fail fast; secrets only from the environment/secret manager.
- **Feature flags & commercial config** (plans, prices, limits) live in the database with versioning — never hardcoded (PRD §3.14).
- **Environments:** local → testing → staging → production (PRD §15). Deployment target is an open decision.

## 9. Known architectural risks

| Risk                                                                                                              | Mitigation                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Habit schedule/occurrence/timezone logic errors corrupt history                                                   | Pure engine, schedule versioning, property-based tests, no silent rewrites                                     |
| Offline sync conflicts lose data                                                                                  | Operation IDs, server idempotency, version columns, explicit per-entity conflict rules, never discard silently |
| iOS PWA push/background limits                                                                                    | Document limits; fall back to email/in-app; feature-detect                                                     |
| Iranian payment providers: recurring billing often unsupported; sanctions/eligibility for international providers | Capability-modelled adapters, manual renewal flows, legal review before activation                             |
| AI cost/abuse and privacy                                                                                         | Quotas per plan, usage tracking, journal opt-in, server-side keys, confirmation for writes                     |
| Tooling churn (TS 7, Prisma 8, ESLint plugin lag)                                                                 | Pinned versions, upgrade issues, ADR-0001                                                                      |
