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

| Path                                                         | Phase | Purpose                                          |
| ------------------------------------------------------------ | ----- | ------------------------------------------------ |
| `apps/web`                                                   | 0     | Next.js App Router; `app/[locale]/…`, `lib/i18n` |
| `apps/api`                                                   | 0     | NestJS; `src/modules/*`, `src/config`, `prisma/` |
| `apps/worker`                                                | 1     | BullMQ consumers (shares API modules/services)   |
| `apps/admin`                                                 | 10    | Admin frontend on a separate origin              |
| `packages/config`                                            | 0     | tsconfig presets, ESLint config                  |
| `packages/ui`                                                | 0→1   | Design tokens → shadcn/ui-based primitives       |
| `packages/shared-types`, `shared-validation`, `localization` | 1     | API contracts, zod schemas, shared messages      |
| `infrastructure/`                                            | 12    | Deployment, Docker images, scripts               |

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

- PostgreSQL is the system of record; Prisma 7 schema at `apps/api/prisma/schema.prisma` (Phase 0: no models). Conceptual entities: PRD §6.
- Conventions (ADR-0006): UUIDv7 IDs, `timestamptz` UTC + user IANA timezone, occurrences keyed by local date + schedule version, money in integer minor units + currency, soft delete where restorable, `version` column for offline-editable entities, idempotency keys for retried writes, migrations only via `prisma migrate`.
- **Habit engine (Phase 3)** is the riskiest domain logic: schedule versions with effective dates → occurrence generation (pure, deterministic function of schedule version + date range + timezone + pauses/vacations) → completions → streaks/consistency. Built as a pure library with exhaustive and property-based tests.
- **Analytics (Phase 6):** metrics computed by deterministic SQL/TS; snapshots materialised by worker jobs; insights carry evidence, time range and confidence.

## 5. API design

- REST under `/api/v1`; OpenAPI generated from Nest decorators (Phase 1).
- DTOs validated at the edge (zod or class-validator — decided in Phase 1 issue); never return Prisma entities directly.
- Error shape: `{ error: { code, message, details?, requestId } }`; `code` is stable and localised by the client.
- Cursor pagination, filtering, sorting conventions defined in Phase 1.
- Auth via secure session cookies (ADR-0005); CSRF protection on state-changing requests; rate limits per IP/user/route class.

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
- **Observability (PRD §10):** structured JSON logs with request IDs and redaction; error tracking; metrics for API latency, queues, payments, AI usage; health/readiness endpoints; uptime checks; alerting. Phase 1 lays the logging/request-ID foundation; Phase 12 completes monitoring.
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
