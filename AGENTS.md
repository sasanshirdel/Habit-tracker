# AGENTS.md — working instructions for coding agents

This file tells any AI coding agent (Claude Code, Copilot, Codex, Cursor, …) **how to work in this
repository**. It is deliberately short. The product itself is specified elsewhere:

| Need                             | Read                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| What to build (canonical spec)   | [`docs/PRODUCT_REQUIREMENTS.md`](docs/PRODUCT_REQUIREMENTS.md)                                            |
| How the system is structured     | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                                                            |
| What to build next               | [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/backlog/BACKLOG.md`](docs/backlog/BACKLOG.md), GitHub Issues |
| Security rules                   | [`docs/SECURITY.md`](docs/SECURITY.md)                                                                    |
| Branches, commits, PRs, env vars | [`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md)                                            |
| When is something "done"         | [`docs/DEFINITION_OF_DONE.md`](docs/DEFINITION_OF_DONE.md)                                                |
| Why things are the way they are  | [`docs/decisions/`](docs/decisions/) (ADRs)                                                               |

If this file and the PRD disagree about **product behaviour**, the PRD wins. This file wins on
**how to work in the repo**.

## Project in one paragraph

Bilingual (Persian RTL + English LTR) personal productivity SaaS and installable PWA: habits (primary),
goals, tasks, planning, focus, journal, analytics/insights, AI coach, notifications, accountability,
dual-channel billing (Iranian + international), and an isolated super-admin. Architecture: **modular
monolith** — Next.js frontend (`apps/web`), NestJS REST API (`apps/api`), PostgreSQL via Prisma,
Redis/BullMQ for background work, pnpm monorepo.

## Every session

1. Inspect repo state first: `git status`, current branch, open PRs/issues, `docs/ROADMAP.md`. Never redo completed work.
2. Pick the next incomplete roadmap item / issue (lowest phase first, respecting dependencies).
3. Create a branch from `main`: `feature/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, or `phase-N/<slug>`.
4. Implement in small, reviewable commits (Conventional Commits).
5. Add/adjust tests proportional to risk. Run the checks below. Fix failures.
6. Update docs/ADRs when behaviour, architecture, env vars or dependencies change.
7. Open a PR using the template; report exactly which checks ran and their real results.

## Commands (Node 24 LTS, pnpm 12 — see `.nvmrc`, `packageManager`)

```bash
pnpm install --frozen-lockfile
pnpm format:check   # prettier
pnpm build:deps     # build packages/* + the API library apps/worker imports; typecheck/test run it first
pnpm lint           # eslint, all packages
pnpm typecheck      # tsc --noEmit, all packages
pnpm test           # vitest, all packages
pnpm build          # all packages
pnpm check          # all of the above in order
pnpm dev:services   # docker compose: postgres + redis (needs Docker)
pnpm --filter @habit/web dev      # http://localhost:3000 -> /en or /fa (negotiated)
pnpm --filter @habit/web test:e2e # route tests against `next start` (after `pnpm build`)
pnpm --filter @habit/web test:browser # Playwright (Chromium) vs next start + API on Postgres/Redis (after build:e2e; ADR-0015)
pnpm --filter @habit/api dev      # http://localhost:4000/api/v1/health
pnpm --filter @habit/worker dev   # BullMQ consumers (apps/worker)
```

## Conventions

- **TypeScript strict** everywhere; no `any` without a justified comment. ESM (`"type": "module"`); API imports use `.js` extensions (NodeNext).
- **Pinned dependency versions** (no `^`). Before adding a dependency: justify it, check current version/maintenance/peers (`npm view`), record it in an ADR or ADR-0001 addendum. Prefer no new dependency.
- **Module boundaries (API):** one Nest module per bounded area under `apps/api/src/modules/<name>/`; other modules use only its exported service interface (ADR-0006).
- **API:** versioned REST under `/api/v1`, DTOs + validation at the edge, consistent error shape with error **codes** (UI localises), OpenAPI docs.
- **Server is the authority** for authz, entitlements, metrics and payments. Frontend checks are UX only.
- **i18n:** no hardcoded UI strings — next-intl ICU messages in `apps/web/lib/i18n/messages/{en,fa}.json` with identical keys and arguments (CI parity test); internal links via `@/lib/i18n/navigation`. Use logical CSS (`ms-/me-/ps-/pe-/start-/end-`), never `left/right` (lint fails). Check every UI change in `/en` and `/fa` (ADR-0004).
- **Design tokens only** — no raw colour values outside `packages/ui` tokens (a test scans web + ui). Build UI from `@habit/ui` primitives (shadcn/ui on Radix, ADR-0013); every user-visible string in a primitive is a prop the app fills from messages.
- **Data:** UTC `timestamptz` + user IANA timezone; habit occurrences by local date; money as integer minor units + currency; never rewrite history silently; Prisma migrations only.
- **Numbers shown to users are computed by deterministic backend code**, never by an LLM.

## Hard guardrails (never)

- Push to `main`, force-push shared branches, or merge without human approval.
- Commit secrets, real `.env` files, tokens, keys, or production data. Only `.env.example` with placeholders.
- Create default/hardcoded admin credentials or seed an admin password (owner bootstrap: `docs/SECURITY.md`).
- Grant admin power to a customer account; trust frontend authorization.
- Run destructive migrations, production deploys, payment-provider activation, or security-setting changes without explicit human approval.
- Let AI features change user data without confirmation; give AI access to journal data without user opt-in.
- Claim a check passed that you did not run, or mark incomplete work as done.
- Add microservices, or a dependency "because the PRD mentions it", without an ADR.

When a requirement is ambiguous and affects security, money, user data or architecture: stop and ask
the owner (open a question in the issue/PR) instead of guessing.
