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
| `apps/web`                   | 0     | Next.js App Router; `app/[locale]/…`, `lib/i18n`                                       |
| `apps/api`                   | 0     | NestJS; `src/modules/*`, `src/config`, `prisma/`                                       |
| `apps/worker`                | 1     | Worker process: BullMQ consumers (P1-03); runs `WorkerModule` from `@habit/api/worker` |
| `apps/admin`                 | 10    | Admin frontend on a separate origin                                                    |
| `packages/config`            | 0     | tsconfig presets, ESLint config                                                        |
| `packages/ui`                | 0→1   | Design tokens → shadcn/ui-based primitives                                             |
| `packages/shared-types`      | 1     | API contract types (responses, error envelope)                                         |
| `packages/shared-validation` | 1     | zod 4 input schemas (locale, time zone, date)                                          |
| `packages/localization`      | 1     | Locale metadata: locales, direction, Intl tags                                         |
| `infrastructure/`            | 12    | Deployment, Docker images, scripts                                                     |

## 3. Backend modules (PRD §5.4)

Grouped by roadmap phase:

| Area                  | Modules                                                                                   | Phase |
| --------------------- | ----------------------------------------------------------------------------------------- | ----- |
| Platform              | config, health, logging, errors, OpenAPI, rate limiting                                   | 1     |
| Identity              | auth, users, profiles, preferences, sessions                                              | 2     |
| Habits                | habits, habit-schedules (versioned), habit-occurrences, habit-templates, streaks          | 3     |
| Execution             | goals, tasks, planning                                                                    | 4     |
| Focus & journal       | focus, journal                                                                            | 5     |
| Intelligence          | analytics (deterministic metrics), insights, recommendations, experiments, reviews        | 6     |
| AI                    | ai-providers (abstraction), ai-coach (conversations, tools, confirmations, usage)         | 7     |
| Engagement            | notifications (in-app, web push, email), sync (offline ops)                               | 8     |
| Commerce              | plans, entitlements, subscriptions, payments (adapters), billing portal, coupons, refunds | 9     |
| Administration        | admin-auth, rbac, admin, support, audit-logs, feature-flags, system-health                | 10    |
| Social & integrations | accountability, integrations (Google Calendar/Tasks)                                      | 11    |

Rules: a module owns its tables; cross-module calls only through exported services; side effects via domain events/queues.

## 4. Data architecture

- PostgreSQL is the system of record; Prisma 7 schema at `apps/api/prisma/schema.prisma` (no product models yet; they arrive with their owning phase). Conceptual entities: PRD §6.
- **Access (P1-01):** `DatabaseModule` (`apps/api/src/database/`) provides a single `PrismaService` (Prisma 7 + `@prisma/adapter-pg`, pool connect timeout 5 s). `DATABASE_URL` is required and validated at boot. The API starts even when the database is down; `GET /api/v1/health` (liveness) never touches the DB, `GET /api/v1/health/ready` (readiness) runs a bounded `SELECT 1` and answers 503 when it fails. Prisma `query` events and Prisma's own error lines are not logged (they can carry personal data).
- **Migrations:** `apps/api/prisma/migrations/`, starting with an empty `…_baseline` migration that only establishes the history. `prisma migrate deploy` in CI/deployments, `prisma migrate dev` locally. CI job `integration · PostgreSQL + Redis` (P1-02) applies migrations to a Postgres 18.7 service container and runs `*.int.test.ts` against a throwaway database (incl. a schema-drift check) and a Redis 8.8.4 service container (per-run key prefix), then verifies teardown left nothing behind.
- Conventions (ADR-0006): UUIDv7 IDs, `timestamptz` UTC + user IANA timezone, occurrences keyed by local date + schedule version, money in integer minor units + currency, soft delete where restorable, `version` column for offline-editable entities, idempotency keys for retried writes, migrations only via `prisma migrate`.
- **Queues (P1-03):** BullMQ 6 on Redis 8. The API's `QueueModule` (`apps/api/src/queue/`) owns one shared ioredis connection, the `QueueProducer` and the Redis readiness check; jobs are typed `JobDefinition`s (`defineJob`: name `<module>.<action>`, queue, strict zod payload schema, options) defined by the module that owns the work. Producers fail fast (`QUEUE_UNAVAILABLE`) instead of buffering when Redis is down, and accept an idempotency `jobId`. Defaults: 3 attempts, exponential backoff from 1 s, failed jobs retained 7 days in the failed set. The worker process (`apps/worker`) boots `WorkerModule` (`apps/api/src/worker/`) as a Nest application context: one BullMQ `Worker` per queue with handlers (`JOB_HANDLERS`), payloads re-validated before handling (invalid/unknown → failed without retry), graceful drain on SIGTERM bounded by `WORKER_SHUTDOWN_TIMEOUT_MS`, then connections close; anything cut off is recovered as a stalled job. Keys are namespaced by `QUEUE_PREFIX` (default `habit:q`). Readiness (`/api/v1/health/ready`) checks PostgreSQL and Redis in parallel.
- **Habit engine (Phase 3)** is the riskiest domain logic: schedule versions with effective dates → occurrence generation (pure, deterministic function of schedule version + date range + timezone + pauses/vacations) → completions → streaks/consistency. Built as a pure library with exhaustive and property-based tests.
- **Analytics (Phase 6):** metrics computed by deterministic SQL/TS; snapshots materialised by worker jobs; insights carry evidence, time range and confidence.

## 5. API design

- REST under `/api/v1`; OpenAPI 3.1 generated from the routes' zod schemas (`ZodValidationPipe` inputs + `@ApiDoc` response schemas, no `@nestjs/swagger`), served as JSON at `/api/docs/openapi.json` outside production (`API_DOCS_ENABLED`) and exported by CI as an artifact; admin routes must be `@ApiExclude()`d (ADR-0012, P1-06).
- Input validated at the edge with zod: `ZodValidationPipe(schema)` per `@Body`/`@Query`/`@Param` → 400 `VALIDATION_FAILED` with `details.issues[{ field, code, message }]` (ADR-0009, P1-05); never return Prisma entities directly.
- Error shape: `{ error: { code, message, details?, requestId } }`, rendered for every failure by the global `AllExceptionsFilter`; `code` is a stable `ApiErrorCode` localised by the client; no stack traces or framework/driver text in any environment.
- Every response carries `x-request-id` (accepted from the caller when well-formed, else a UUID), also available in-process via `currentRequestId()`.
- Lists: cursor (keyset) pagination `?limit=&cursor=` → `{ data, page: { nextCursor, hasMore, limit } }`; `?sort=-field,field` over whitelisted fields; explicit typed filter parameters (ADR-0009). Helpers in `apps/api/src/common/`.
- Auth via secure session cookies (ADR-0005); CSRF protection on state-changing requests.
- Security headers on every response, exact CORS allow-list, and rate limits per user-or-address and route class (`default` on every route; `@RateLimit('auth' | 'expensive')`; `@SkipRateLimit()` for probes only) with Redis counters → 429 `RATE_LIMITED` + `Retry-After` (ADR-0011, P1-08). The web app sets a per-request nonce CSP in `apps/web/proxy.ts`, so its pages render dynamically.

## 6. Frontend architecture

- App Router with `[locale]` segment; `<html lang dir>` from locale (ADR-0004).
- Server components by default; client components for interaction. TanStack Query for client cache of API data (Phase 1).
- Design tokens (`packages/ui`) → Tailwind theme; dark (default) + light themes; logical CSS only.
- PWA (Phase 8): manifest, service worker, IndexedDB store + operation queue, background sync where supported; documented offline matrix.

## 7. Initial information architecture

Primary navigation (PRD §2.3), validated during Phase 1 design work:

| Desktop sidebar | Mobile bottom bar (≤5) | Route (`/{locale}/…`)                                                                       |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| Overview        | Overview               | `/` (dashboard)                                                                             |
| Habits          | Habits                 | `/habits`, `/habits/[id]`, `/habits/templates`                                              |
| Goals           | — (via "More")         | `/goals`, `/goals/[id]`                                                                     |
| Tasks           | Tasks                  | `/tasks` (list / calendar / kanban views)                                                   |
| Planner         | Planner                | `/planner/day`, `/planner/week`, `/planner/matrix`                                          |
| Focus           | —                      | `/focus`, `/focus/history`                                                                  |
| Journal         | —                      | `/journal`, `/journal/[date]`                                                               |
| Insights        | —                      | `/insights`, `/insights/reviews`, `/insights/experiments`                                   |
| AI Coach        | —                      | `/coach`                                                                                    |
| Settings        | More                   | `/settings/{profile,preferences,notifications,privacy,billing,integrations,accountability}` |

Public: `/{locale}` landing, `/{locale}/pricing`, `/{locale}/auth/*`, `/{locale}/onboarding`. Admin: separate app.
Quick capture is a global action (keyboard shortcut / FAB), not a page.

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
