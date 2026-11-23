# Backlog

113 issues covering every roadmap phase. Machine-readable source: [`issues.json`](issues.json)
(fields: `id`, `title`, `labels`, `dependencies`, `body`). Each body contains Description, Scope, Dependencies,
Acceptance criteria, Testing requirements and Security considerations.

When filed on GitHub, keep the backlog ID (e.g. `P3-02`) in the issue body so dependencies can be cross-referenced.

| Phase                                          | Issues  |
| ---------------------------------------------- | ------- |
| 0 — Product definition & repository foundation | 3       |
| 1 — Application foundation                     | 16      |
| 2 — Authentication & user management           | 10      |
| 3 — Habit tracking core                        | 10      |
| 4 — Goals, tasks & planning                    | 10      |
| 5 — Focus & journal                            | 6       |
| 6 — Analytics & performance intelligence       | 6       |
| 7 — AI coach                                   | 6       |
| 8 — PWA & notifications                        | 8       |
| 9 — SaaS, billing & payments                   | 10      |
| 10 — Super admin & security hardening          | 13      |
| 11 — Accountability & advanced integrations    | 6       |
| 12 — Quality assurance & production launch     | 9       |
| **Total**                                      | **113** |

## Phase 0 — Product definition & repository foundation

| ID    | Title                                                                       | Labels                                | Depends on |
| ----- | --------------------------------------------------------------------------- | ------------------------------------- | ---------- |
| P0-01 | Phase 0: repository foundation (monorepo, docs, ADRs, CI)                   | `phase:0`, `area:infra`, `type:chore` | —          |
| P0-02 | Configure GitHub repository settings: branch protection, labels, visibility | `phase:0`, `area:infra`, `type:chore` | P0-01      |
| P0-03 | Verify Docker dev environment on a Docker-capable machine                   | `phase:0`, `area:infra`, `type:chore` | P0-01      |

## Phase 1 — Application foundation

| ID    | Title                                                                   | Labels                                          | Depends on   |
| ----- | ----------------------------------------------------------------------- | ----------------------------------------------- | ------------ |
| P1-01 | Database foundation: Prisma client, first migration, DB health check    | `phase:1`, `area:db`, `type:feature`            | P0-03        |
| P1-02 | CI: Postgres + Redis service containers for integration tests           | `phase:1`, `area:infra`, `type:chore`           | P1-01        |
| P1-03 | Redis, BullMQ and the worker application                                | `phase:1`, `area:infra`, `type:feature`         | P1-01        |
| P1-04 | Shared packages: shared-types, shared-validation, localization          | `phase:1`, `area:shared`, `type:feature`        | P0-01        |
| P1-05 | API conventions: error format, validation pipe, pagination, request IDs | `phase:1`, `area:api`, `type:feature`           | P1-04        |
| P1-06 | OpenAPI / Swagger documentation                                         | `phase:1`, `area:api`, `type:feature`           | P1-05        |
| P1-07 | Structured logging with redaction                                       | `phase:1`, `area:observability`, `type:feature` | P1-05        |
| P1-08 | Security headers, CORS hardening and rate limiting baseline             | `phase:1`, `area:security`, `type:feature`      | P1-03        |
| P1-09 | Design system: shadcn/ui primitives, themes, fonts                      | `phase:1`, `area:ui`, `type:feature`            | P0-01        |
| P1-10 | next-intl integration: locale negotiation, ICU messages, RTL/LTR        | `phase:1`, `area:i18n`, `type:feature`          | P1-04        |
| P1-11 | Responsive application shell and navigation                             | `phase:1`, `area:web`, `type:feature`           | P1-09, P1-10 |
| P1-12 | Frontend data layer: API client, TanStack Query, error handling         | `phase:1`, `area:web`, `type:feature`           | P1-05, P1-04 |
| P1-13 | Playwright E2E harness and smoke tests in CI                            | `phase:1`, `area:testing`, `type:chore`         | P1-11        |
| P1-14 | Supply-chain and code scanning in CI                                    | `phase:1`, `area:security`, `type:chore`        | P0-02        |
| P1-15 | Architecture test enforcing module boundaries                           | `phase:1`, `area:api`, `type:chore`             | P1-05        |
| P1-16 | Tooling upgrade watch: TypeScript 7, Prisma 8, ESLint React plugins     | `phase:1`, `area:infra`, `type:chore`           | P0-01        |

## Phase 2 — Authentication & user management

| ID    | Title                                                           | Labels                                    | Depends on   |
| ----- | --------------------------------------------------------------- | ----------------------------------------- | ------------ |
| P2-01 | Identity data model: users, credentials, sessions               | `phase:2`, `area:auth`, `type:feature`    | P1-01        |
| P2-02 | Registration and login with email/password (Argon2id)           | `phase:2`, `area:auth`, `type:feature`    | P2-01, P1-08 |
| P2-03 | CSRF protection and authentication guards                       | `phase:2`, `area:auth`, `type:feature`    | P2-02        |
| P2-04 | Email verification and transactional email foundation           | `phase:2`, `area:auth`, `type:feature`    | P2-02, P1-03 |
| P2-05 | Password recovery                                               | `phase:2`, `area:auth`, `type:feature`    | P2-04        |
| P2-06 | Google sign-in (OIDC)                                           | `phase:2`, `area:auth`, `type:feature`    | P2-02        |
| P2-07 | Profile, avatar and preferences (language, timezone, theme)     | `phase:2`, `area:users`, `type:feature`   | P2-03        |
| P2-08 | Session management UI and security events                       | `phase:2`, `area:users`, `type:feature`   | P2-02        |
| P2-09 | Auth UI: register, login, verify, reset, settings pages (fa/en) | `phase:2`, `area:web`, `type:feature`     | P2-02, P1-11 |
| P2-10 | Data export and account deletion                                | `phase:2`, `area:privacy`, `type:feature` | P2-07, P1-03 |

## Phase 3 — Habit tracking core

| ID    | Title                                                                         | Labels                                   | Depends on          |
| ----- | ----------------------------------------------------------------------------- | ---------------------------------------- | ------------------- |
| P3-01 | Habit domain model: habits, categories, types, schedule versions, occurrences | `phase:3`, `area:habits`, `type:feature` | P2-01               |
| P3-02 | Schedule engine (pure library)                                                | `phase:3`, `area:habits`, `type:feature` | P3-01               |
| P3-03 | Schedule versioning: edits create new versions, history preserved             | `phase:3`, `area:habits`, `type:feature` | P3-02               |
| P3-04 | Occurrence status and completion logic for all habit types                    | `phase:3`, `area:habits`, `type:feature` | P3-02               |
| P3-05 | Streaks and consistency metrics                                               | `phase:3`, `area:habits`, `type:feature` | P3-04               |
| P3-06 | Habits API: CRUD, archive/restore, reorder, categories                        | `phase:3`, `area:habits`, `type:feature` | P3-01, P1-05        |
| P3-07 | Weekly habit matrix (desktop)                                                 | `phase:3`, `area:web`, `type:feature`    | P3-06, P3-05, P1-12 |
| P3-08 | Mobile habit experience (week strip, cards, touch targets)                    | `phase:3`, `area:web`, `type:feature`    | P3-07               |
| P3-09 | Habit detail page: calendar, heatmap, trends, notes, activity                 | `phase:3`, `area:web`, `type:feature`    | P3-07               |
| P3-10 | Habit templates library and guided onboarding                                 | `phase:3`, `area:habits`, `type:feature` | P3-06               |

## Phase 4 — Goals, tasks & planning

| ID    | Title                                                                         | Labels                                     | Depends on          |
| ----- | ----------------------------------------------------------------------------- | ------------------------------------------ | ------------------- |
| P4-01 | Goals: model, CRUD, types, priority, status, archiving                        | `phase:4`, `area:goals`, `type:feature`    | P2-03               |
| P4-02 | Milestones, measurable progress and progress history                          | `phase:4`, `area:goals`, `type:feature`    | P4-01               |
| P4-03 | Goal ↔ habit ↔ task relationships                                             | `phase:4`, `area:goals`, `type:feature`    | P4-01, P3-06, P4-04 |
| P4-04 | Tasks: model and API (subtasks, checklists, tags, priority, dates, durations) | `phase:4`, `area:tasks`, `type:feature`    | P2-03               |
| P4-05 | Recurring tasks and task reminders data                                       | `phase:4`, `area:tasks`, `type:feature`    | P4-04               |
| P4-06 | Task views: list, calendar, kanban; search and filtering                      | `phase:4`, `area:web`, `type:feature`      | P4-04, P1-12        |
| P4-07 | Daily and weekly planner with time blocking                                   | `phase:4`, `area:planning`, `type:feature` | P4-04               |
| P4-08 | Eisenhower matrix view                                                        | `phase:4`, `area:planning`, `type:feature` | P4-06               |
| P4-09 | Daily/weekly review and planned-vs-actual                                     | `phase:4`, `area:planning`, `type:feature` | P4-07               |
| P4-10 | Smart planning suggestions (rule-based)                                       | `phase:4`, `area:planning`, `type:feature` | P4-07, P4-09        |

## Phase 5 — Focus & journal

| ID    | Title                                              | Labels                                         | Depends on   |
| ----- | -------------------------------------------------- | ---------------------------------------------- | ------------ |
| P5-01 | Focus sessions and Pomodoro timer                  | `phase:5`, `area:focus`, `type:feature`        | P4-04        |
| P5-02 | Focus analytics                                    | `phase:5`, `area:focus`, `type:feature`        | P5-01        |
| P5-03 | Journal entries, tags, search and calendar history | `phase:5`, `area:journal`, `type:feature`      | P2-03        |
| P5-04 | Quick capture (global)                             | `phase:5`, `area:journal`, `type:feature`      | P5-03, P4-04 |
| P5-05 | Optional mood, energy and stress tracking          | `phase:5`, `area:journal`, `type:feature`      | P5-03        |
| P5-06 | Voice-to-text capture                              | `phase:5`, `area:integrations`, `type:feature` | P5-04        |

## Phase 6 — Analytics & performance intelligence

| ID    | Title                                                | Labels                                      | Depends on   |
| ----- | ---------------------------------------------------- | ------------------------------------------- | ------------ |
| P6-01 | Deterministic metrics engine and analytics snapshots | `phase:6`, `area:analytics`, `type:feature` | P3-05, P1-03 |
| P6-02 | Performance dashboard and visualizations             | `phase:6`, `area:web`, `type:feature`       | P6-01        |
| P6-03 | Insight detection with evidence and confidence       | `phase:6`, `area:insights`, `type:feature`  | P6-01        |
| P6-04 | Recommendation lifecycle and feedback                | `phase:6`, `area:insights`, `type:feature`  | P6-03        |
| P6-05 | Improvement experiments                              | `phase:6`, `area:insights`, `type:feature`  | P6-04        |
| P6-06 | Weekly and monthly reviews                           | `phase:6`, `area:insights`, `type:feature`  | P6-01, P6-03 |

## Phase 7 — AI coach

| ID    | Title                                                              | Labels                                | Depends on   |
| ----- | ------------------------------------------------------------------ | ------------------------------------- | ------------ |
| P7-01 | AI provider abstraction and configuration                          | `phase:7`, `area:ai`, `type:feature`  | P1-03        |
| P7-02 | AI usage tracking, quotas, rate limits and cost controls           | `phase:7`, `area:ai`, `type:feature`  | P7-01        |
| P7-03 | AI coach conversations and context retrieval with privacy controls | `phase:7`, `area:ai`, `type:feature`  | P7-01, P6-01 |
| P7-04 | Controlled AI tools with authorization and confirmation workflow   | `phase:7`, `area:ai`, `type:feature`  | P7-03        |
| P7-05 | AI coach UI (fa/en)                                                | `phase:7`, `area:web`, `type:feature` | P7-04        |
| P7-06 | AI goal breakdown and weekly planning assistance                   | `phase:7`, `area:ai`, `type:feature`  | P7-04, P4-02 |

## Phase 8 — PWA & notifications

| ID    | Title                                                                          | Labels                                          | Depends on          |
| ----- | ------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------- |
| P8-01 | Web app manifest, service worker and install experience                        | `phase:8`, `area:pwa`, `type:feature`           | P1-11               |
| P8-02 | Offline storage and operation queue (IndexedDB)                                | `phase:8`, `area:sync`, `type:feature`          | P8-01, P3-04, P4-04 |
| P8-03 | Server sync endpoint: idempotency, versions, conflict detection and resolution | `phase:8`, `area:sync`, `type:feature`          | P8-02               |
| P8-04 | Notification infrastructure, in-app notifications and preferences              | `phase:8`, `area:notifications`, `type:feature` | P1-03, P2-07        |
| P8-05 | Web Push notifications                                                         | `phase:8`, `area:notifications`, `type:feature` | P8-04, P8-01        |
| P8-06 | Email notifications and localized templates                                    | `phase:8`, `area:notifications`, `type:feature` | P8-04, P2-04        |
| P8-07 | Habit, task, goal, focus, inactivity reminders                                 | `phase:8`, `area:notifications`, `type:feature` | P8-04, P3-06, P4-05 |
| P8-08 | Document offline capabilities and platform limitations                         | `phase:8`, `area:docs`, `type:docs`             | P8-03, P8-05        |

## Phase 9 — SaaS, billing & payments

| ID    | Title                                                    | Labels                                     | Depends on    |
| ----- | -------------------------------------------------------- | ------------------------------------------ | ------------- |
| P9-01 | Plans, plan versions, prices and entitlements model      | `phase:9`, `area:billing`, `type:feature`  | P2-01         |
| P9-02 | Centralized entitlement service enforced server-side     | `phase:9`, `area:billing`, `type:feature`  | P9-01         |
| P9-03 | Subscription lifecycle state machine                     | `phase:9`, `area:billing`, `type:feature`  | P9-01         |
| P9-04 | Payment adapter interface with explicit capability model | `phase:9`, `area:payments`, `type:feature` | P9-03         |
| P9-05 | Iranian payment gateway adapter (sandbox)                | `phase:9`, `area:payments`, `type:feature` | P9-04         |
| P9-06 | International payment provider adapter (sandbox)         | `phase:9`, `area:payments`, `type:feature` | P9-04         |
| P9-07 | Webhook verification, idempotency and reconciliation     | `phase:9`, `area:payments`, `type:feature` | P9-05, P9-06  |
| P9-08 | Pricing page, checkout flow and customer billing portal  | `phase:9`, `area:web`, `type:feature`      | P9-02, P9-07  |
| P9-09 | Coupons and redemptions                                  | `phase:9`, `area:billing`, `type:feature`  | P9-01         |
| P9-10 | Refund workflows and invoices/receipts                   | `phase:9`, `area:billing`, `type:feature`  | P9-07, P10-04 |

## Phase 10 — Super admin & security hardening

| ID     | Title                                                                                           | Labels                                                    | Depends on           |
| ------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------- |
| P10-01 | Admin identity foundation: separate model, auth flow and sessions                               | `phase:10`, `area:admin`, `type:feature`, `priority:high` | P2-02                |
| P10-02 | Secure documented owner bootstrap (CLI, single-use enrolment)                                   | `phase:10`, `area:admin`, `type:feature`, `priority:high` | P10-01, P10-03       |
| P10-03 | Admin MFA: passkeys/WebAuthn, TOTP, recovery codes                                              | `phase:10`, `area:admin`, `type:feature`, `priority:high` | P10-01               |
| P10-04 | RBAC permissions, guards and step-up authentication                                             | `phase:10`, `area:admin`, `type:feature`, `priority:high` | P10-03               |
| P10-05 | Append-only admin audit log                                                                     | `phase:10`, `area:audit`, `type:feature`                  | P10-01               |
| P10-06 | Admin app shell and owner dashboard metrics                                                     | `phase:10`, `area:admin`, `type:feature`                  | P10-04, P6-01, P9-03 |
| P10-07 | User management and audited support access                                                      | `phase:10`, `area:admin`, `type:feature`                  | P10-04, P10-05       |
| P10-08 | Subscription, plan and payment administration                                                   | `phase:10`, `area:admin`, `type:feature`                  | P10-04, P9-07        |
| P10-09 | AI management console                                                                           | `phase:10`, `area:admin`, `type:feature`                  | P10-04, P7-02        |
| P10-10 | Content management: templates, categories, translations, help/FAQ, notification/email templates | `phase:10`, `area:admin`, `type:feature`                  | P10-04               |
| P10-11 | Support ticketing                                                                               | `phase:10`, `area:admin`, `type:feature`                  | P10-04               |
| P10-12 | System management: health, jobs, errors, feature flags, maintenance mode                        | `phase:10`, `area:admin`, `type:feature`                  | P10-04, P1-03        |
| P10-13 | Security monitoring and pre-production authorization review                                     | `phase:10`, `area:security`, `type:chore`                 | P10-04, P10-05       |

## Phase 11 — Accountability & advanced integrations

| ID     | Title                                                                    | Labels                                            | Depends on    |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------- | ------------- |
| P11-01 | Accountability invitations and partner relationships                     | `phase:11`, `area:accountability`, `type:feature` | P2-03         |
| P11-02 | Shared-progress permissions and encouragement                            | `phase:11`, `area:accountability`, `type:feature` | P11-01, P8-04 |
| P11-03 | Integration framework: connection lifecycle, token protection, sync logs | `phase:11`, `area:integrations`, `type:feature`   | P1-03, P2-03  |
| P11-04 | Google Calendar integration                                              | `phase:11`, `area:integrations`, `type:feature`   | P11-03, P4-07 |
| P11-05 | Google Tasks integration                                                 | `phase:11`, `area:integrations`, `type:feature`   | P11-03, P4-04 |
| P11-06 | Advanced reporting                                                       | `phase:11`, `area:analytics`, `type:feature`      | P6-02         |

## Phase 12 — Quality assurance & production launch

| ID     | Title                                                                      | Labels                                           | Depends on                                     |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| P12-01 | E2E coverage of all 15 critical PRD user journeys                          | `phase:12`, `area:testing`, `type:chore`         | P9-08, P10-06                                  |
| P12-02 | Accessibility and localization QA                                          | `phase:12`, `area:testing`, `type:chore`         | P12-01                                         |
| P12-03 | Performance and load testing                                               | `phase:12`, `area:testing`, `type:chore`         | P12-01                                         |
| P12-04 | Security testing (DAST/pen test) and dependency audit                      | `phase:12`, `area:security`, `type:chore`        | P10-13                                         |
| P12-05 | Production observability: error tracking, metrics, uptime, alerting        | `phase:12`, `area:observability`, `type:feature` | P1-07                                          |
| P12-06 | Staging and production environments, deployment pipeline                   | `phase:12`, `area:infra`, `type:feature`         | P12-05                                         |
| P12-07 | Backups and tested restoration                                             | `phase:12`, `area:infra`, `type:chore`           | P12-06                                         |
| P12-08 | Legal, privacy, tax and payment compliance review for launch jurisdictions | `phase:12`, `area:privacy`, `type:chore`         | P9-05, P9-06                                   |
| P12-09 | Launch checklist and go/no-go                                              | `phase:12`, `area:release`, `type:chore`         | P12-01, P12-02, P12-03, P12-04, P12-07, P12-08 |

## Label set

`area:accountability`, `area:admin`, `area:ai`, `area:analytics`, `area:api`, `area:audit`, `area:auth`, `area:billing`, `area:db`, `area:docs`, `area:focus`, `area:goals`, `area:habits`, `area:i18n`, `area:infra`, `area:insights`, `area:integrations`, `area:journal`, `area:notifications`, `area:observability`, `area:payments`, `area:planning`, `area:privacy`, `area:pwa`, `area:release`, `area:security`, `area:shared`, `area:sync`, `area:tasks`, `area:testing`, `area:ui`, `area:users`, `area:web`, `phase:0`, `phase:1`, `phase:10`, `phase:11`, `phase:12`, `phase:2`, `phase:3`, `phase:4`, `phase:5`, `phase:6`, `phase:7`, `phase:8`, `phase:9`, `priority:high`, `type:chore`, `type:docs`, `type:feature`
