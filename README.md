# Habit Tracker — Personal Productivity & Performance Platform

A premium, bilingual (**Persian RTL** / **English LTR**) personal productivity SaaS and installable
PWA. Habit tracking is the core, extended with goals, tasks, planning, focus, journaling,
performance analytics, an AI coach, notifications, optional accountability, dual-channel billing,
and an isolated super-admin.

> **Status: Phase 0 — foundation.** The repository contains the monorepo scaffold, tooling, CI and
> documentation. No product features exist yet. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Documentation

| Document                                                       | Purpose                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| [`docs/PRODUCT_REQUIREMENTS.md`](docs/PRODUCT_REQUIREMENTS.md) | Canonical product + engineering specification (PRD)            |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                 | System architecture, modules, data, information architecture   |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                           | Phases 0–12, deliverables, acceptance criteria, open decisions |
| [`docs/SECURITY.md`](docs/SECURITY.md)                         | Security model, admin identity, secrets, owner bootstrap       |
| [`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md) | Setup, env vars, branches, commits, PRs, coding standards      |
| [`docs/DEFINITION_OF_DONE.md`](docs/DEFINITION_OF_DONE.md)     | Quality gates for features and phases                          |
| [`docs/decisions/`](docs/decisions/)                           | Architecture Decision Records                                  |
| [`docs/backlog/`](docs/backlog/)                               | Full implementation backlog (`issues.json` + index)            |
| [`AGENTS.md`](AGENTS.md)                                       | Instructions for AI coding agents                              |

## Tech stack (pinned versions: [ADR-0001](docs/decisions/0001-technology-stack-and-versions.md))

- **Web:** Next.js 16 (App Router) · React 19 · TypeScript 6 (strict) · Tailwind CSS 4 · (Phase 1: shadcn/ui, next-intl, TanStack Query)
- **API:** NestJS 12 (ESM) · zod · Prisma 7 · PostgreSQL 18
- **Background work:** Redis 8 · BullMQ 6 (`apps/worker`)
- **Tooling:** pnpm 12 workspaces · Node 24 LTS · ESLint 10 · Prettier · Vitest 5 · GitHub Actions · Docker Compose (dev services)

## Repository layout

```
apps/
  web/            Next.js frontend — /en (LTR) and /fa (RTL)
  api/            NestJS REST API — /api/v1, Prisma schema in prisma/
  worker/         background worker process — BullMQ consumers sharing the API's modules
packages/
  config/         shared tsconfig presets + ESLint flat config
  ui/             design tokens (TS + CSS variables); shared UI from Phase 1
  shared-types/   API contract types shared by web and api
  shared-validation/  zod 4 input schemas shared by web and api
  localization/   locale metadata (locales, RTL/LTR direction, Intl tags)
docs/             PRD, architecture, roadmap, security, workflow, ADRs, backlog
.github/          CI workflow, PR + issue templates, Copilot pointer
docker-compose.yml  Postgres + Redis for local development only
```

## Quick start

Prerequisites: **Node.js 24 LTS** (`.nvmrc`), **pnpm 12** (`corepack enable` or standalone), Docker (for local Postgres/Redis).

```bash
cp .env.example .env            # placeholders only; adjust locally
pnpm install
pnpm dev:services               # postgres:18.7 + redis:8.8.4 on 127.0.0.1 (Docker)
pnpm build:deps                 # shared packages + API library (dist/)
pnpm --filter @habit/api dev    # http://localhost:4000/api/v1/health
pnpm --filter @habit/worker dev # background jobs (BullMQ)
pnpm --filter @habit/web dev    # http://localhost:3000  (redirects to /en; try /fa)
```

Quality checks (the same ones CI runs):

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
# or: pnpm check
```

## Contributing

All changes go through a pull request from a short-lived branch; `main` is protected. Read
[`docs/DEVELOPMENT_WORKFLOW.md`](docs/DEVELOPMENT_WORKFLOW.md) and
[`docs/DEFINITION_OF_DONE.md`](docs/DEFINITION_OF_DONE.md) first. Report vulnerabilities privately as
described in [`docs/SECURITY.md`](docs/SECURITY.md).

## License

Proprietary — all rights reserved (no license granted). Product name is TBD.
