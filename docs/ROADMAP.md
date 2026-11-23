# Roadmap

Derived from PRD §11. Each phase produces a working, tested, documented increment. Issues for every
phase are in [`backlog/BACKLOG.md`](backlog/BACKLOG.md) (`backlog/issues.json` is the machine-readable
source for creating GitHub Issues).

Status legend: ✅ done · 🟡 in progress · ⬜ not started

| Phase | Name                                       | Status       |
| ----- | ------------------------------------------ | ------------ |
| 0     | Product definition & repository foundation | 🟡 (this PR) |
| 1     | Application foundation                     | 🟡           |
| 2     | Authentication & user management           | ⬜           |
| 3     | Habit tracking core                        | ⬜           |
| 4     | Goals, tasks & planning                    | ⬜           |
| 5     | Focus & journal                            | ⬜           |
| 6     | Analytics & performance intelligence       | ⬜           |
| 7     | AI coach                                   | ⬜           |
| 8     | PWA & notifications                        | ⬜           |
| 9     | SaaS, billing & payments                   | ⬜           |
| 10    | Super admin & security hardening           | ⬜           |
| 11    | Accountability & advanced integrations     | ⬜           |
| 12    | Quality assurance & production launch      | ⬜           |

> Note on ordering: the PRD puts the admin identity in Phase 10, but plan/price/entitlement
> administration is needed in Phase 9. The backlog therefore schedules a **minimal admin
> identity + MFA + RBAC core** early in Phase 9's dependencies (issue "Admin identity foundation"
> is tagged `phase:10` but must be completed before Phase 9 admin endpoints). This is an open
> sequencing decision for the owner.

---

## Phase 0 — Product definition & repository foundation

**Deliverables:** architecture document, product requirements, initial information architecture, monorepo, development environment, Docker dev setup, env var docs, GitHub Actions baseline, coding standards, branch strategy, PR template, issue templates, initial ADRs, full backlog.

**Acceptance criteria:**

- [x] Repository builds (`pnpm build` — verified locally)
- [~] Development environment starts — API and web verified locally; `docker compose` **not verified** (no Docker in the build sandbox)
- [~] CI runs — workflow written and its steps verified locally; first GitHub run happens on the PR
- [x] Documentation available
- [x] No secrets committed

## Phase 1 — Application foundation

Next.js frontend and NestJS backend foundations, PostgreSQL + Prisma (first migration, DB health), Redis + BullMQ worker app, shared packages (types, validation, localization), design system (shadcn/ui, tokens, dark/light themes, fonts), responsive app shell & navigation, next-intl with fa/en + RTL/LTR, API conventions (errors, validation, pagination), OpenAPI docs, logging/request IDs, security headers, rate limiting, Playwright smoke tests, CI DB integration tests and security scanning.

**Acceptance:** both apps run · migrations work · shared packages compile · both languages render correctly (incl. RTL) · responsive layout works · CI passes.

## Phase 2 — Authentication & user management

Registration, login, sessions, email verification, password recovery, Google sign-in, profiles (avatar), preferences (language, timezone, theme), session management, account settings, data export and account deletion foundations. Security requirements implemented before protected functionality.

**Acceptance:** a user can register, verify, log in/out, recover a password, sign in with Google, manage profile/preferences/sessions; all protected endpoints reject unauthenticated/cross-user access (tested).

## Phase 3 — Habit tracking core

Habit CRUD, categories, six habit types, schedule engine, schedule versioning, occurrence generation, completion logic, streaks/consistency, weekly matrix (desktop + mobile), habit details/history/heatmap, templates, guided onboarding. **Extensive unit and integration testing.**

**Acceptance:** deterministic, tested occurrence and streak calculations across timezones/DST/pauses; schedule edits never rewrite history; weekly matrix usable on mobile and in RTL.

## Phase 4 — Goals, tasks & planning

Goals + milestones + progress, tasks + subtasks + checklists + recurrence, list/calendar/kanban views, Eisenhower matrix, daily/weekly planner, time blocking, conflict detection, reviews, habit/goal/task relationships.

## Phase 5 — Focus & journal

Pomodoro/focus sessions linked to tasks/goals, focus analytics, quick capture, journal with tags and search, voice-to-text, optional mood/energy/stress records; journal private by default.

## Phase 6 — Analytics & performance intelligence

Deterministic metrics engine and snapshots, performance dashboard, habit/goal/task/focus analytics, heatmaps, comparative analytics, evidence-based insight detection with confidence levels, recommendation lifecycle, improvement experiments, weekly/monthly reviews.

## Phase 7 — AI coach

Provider abstraction, model/provider configuration, conversations, context retrieval with privacy controls, structured outputs, controlled tool calling with authz, analytics Q&A, goal breakdown, habit and planning suggestions, confirmation workflows, usage/cost tracking and quotas, prompt versioning.

## Phase 8 — PWA & notifications

Manifest, service worker, install experience, IndexedDB storage, offline check-ins and task updates, sync queue with idempotency and conflict resolution, web push, in-app and email notifications, preferences (quiet hours, channels), documented offline/iOS limitations.

## Phase 9 — SaaS, billing & payments

Configurable versioned plans and prices, centralized entitlement service, subscription lifecycle, payment adapter interface, Iranian and international adapters, webhook verification/idempotency, reconciliation, customer billing portal, coupons, refunds, billing history, subscription administration.

## Phase 10 — Super admin & security hardening

Dedicated owner identity and secure bootstrap, separate admin auth, MFA (passkeys/TOTP/recovery codes), RBAC, step-up, admin dashboard (users, subscriptions, payments, AI, content, support, system health), audit logs, security monitoring, authorization review.

## Phase 11 — Accountability & advanced integrations

Accountability invitations, partner relationships, shared-progress permissions, encouragement, Google Calendar and Google Tasks integrations, integration framework, advanced reporting.

## Phase 12 — Quality assurance & production launch

Functional, integration, E2E (all 15 PRD journeys), security, performance, accessibility, localization, mobile, offline and payment-sandbox testing; observability and alerting; backup restoration testing; staging/production environments; deployment rehearsal; legal/privacy review; launch checklist.

---

## Outstanding decisions (owner input needed)

1. **Default locale** for `/` and new users: `fa` or `en` (stub uses `en`)?
2. **Product name / domain** (PRD: TBD) — affects cookies, emails, PWA manifest.
3. **Hosting / deployment target** (region matters for Iranian users and payment providers) and secret manager.
4. **Payment providers**: which Iranian gateway(s) and which international provider (subject to eligibility — PRD §3.14).
5. **AI provider(s)** and data-processing constraints.
6. **Admin sequencing** (see note above) and whether `apps/admin` is a separate deployment from day one.
7. **Redis vs Valkey** for production (licensing).
8. **Calendar display** for Persian users (Solar Hijri default?).
9. **Repository visibility**: PRD says private initially — confirm current GitHub visibility.
