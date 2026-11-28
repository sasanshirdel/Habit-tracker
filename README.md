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
  habit-engine/   pure habit logic — schedule engine, local-date + Solar Hijri arithmetic (ADR-0029)
docs/             PRD, architecture, roadmap, security, workflow, ADRs, backlog
.github/          CI workflow, PR + issue templates, Copilot pointer
docker-compose.yml  Postgres + Redis for local development only
```

## Run locally

Prerequisites: **Node.js 24 LTS** (`.nvmrc` = 24.22.3), **pnpm 12** (`corepack enable` or a
standalone install) and **PostgreSQL 18 + Redis 8** — either through Docker (recommended) or
installed natively. Three processes run side by side: the API on **:4000**, the worker (no port)
and the web app on **:3000**. The browser calls the API directly at `NEXT_PUBLIC_API_BASE_URL`
(`http://localhost:4000/api/v1` in `.env.example`); all three apps read the one repository-root
`.env`.

### 1. Configure

```bash
# macOS / Linux / Git Bash / WSL
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

The placeholders work as they are for a local setup. Open the app at **`http://localhost:3000`**
(not `127.0.0.1` — the API only accepts the origins in `CORS_ORIGINS`). If you change a port, change
it everywhere it appears: `API_PORT` ↔ `NEXT_PUBLIC_API_BASE_URL`, and the web origin ↔
`CORS_ORIGINS` / `WEB_APP_URL`.

### 2. Start PostgreSQL and Redis

**With Docker** (any OS with Docker Desktop / Docker Engine + Compose):

```bash
pnpm dev:services               # postgres:18.7 + redis:8.8.4 on 127.0.0.1, credentials from .env
```

**Without Docker:** install PostgreSQL 18 and Redis 8 natively (macOS: `brew install postgresql@18
redis`; Debian/Ubuntu: the PGDG and Redis apt repositories; Windows: the PostgreSQL installer, and
Redis inside WSL or a Redis-compatible server such as Memurai). Then create the role and database
`.env` expects (or point `DATABASE_URL` / `REDIS_URL` at your own):

```bash
psql -U postgres -c "CREATE ROLE habit LOGIN CREATEDB PASSWORD 'change-me-local-only'"
psql -U postgres -c "CREATE DATABASE habit_dev OWNER habit"
redis-server                    # or start the Redis service; default port 6379
```

### 3. Install, migrate, build the shared packages

```bash
pnpm install
pnpm --filter @habit/api db:migrate:deploy   # apply migrations to the local database
pnpm build:deps                              # shared packages + API library the worker imports
```

### 4. Run (three terminals)

```bash
pnpm --filter @habit/api dev     # http://localhost:4000/api/v1/health → {"status":"ok",…}
pnpm --filter @habit/worker dev  # background jobs: emails (written to .mail-outbox/), purges
pnpm --filter @habit/web dev     # http://localhost:3000 → /en (try /fa)
```

Sign up at `http://localhost:3000/en/auth/sign-up`. No email is delivered locally: with
`MAIL_TRANSPORT=outbox` the worker writes each email as a JSON file to `apps/worker/.mail-outbox/`
— open the newest one and follow its verification link.

Production mode instead of `dev`: `pnpm build` once, then `pnpm --filter @habit/api start`,
`pnpm --filter @habit/worker start` and `pnpm --filter @habit/web start`. `NEXT_PUBLIC_API_BASE_URL`
is baked into the web build, so rebuild the web app after changing it.

### Troubleshooting

| Symptom                                                                   | Cause and fix                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every request from the web app answers **404** (sign-in "couldn't find…") | The browser calls `/api/v1` on `:3000` because `NEXT_PUBLIC_API_BASE_URL` is unset — the web dev server prints a warning saying so. Set it in the root `.env` (or `apps/web/.env.local`) and **restart** the web app; for `next start`, rebuild. |
| Requests fail with a CORS error                                           | The page origin is not in `CORS_ORIGINS` (e.g. you opened `127.0.0.1:3000`). Use `http://localhost:3000` or add the origin.                                                                                                                      |
| The API exits at boot with an env error                                   | `DATABASE_URL` / `REDIS_URL` missing or invalid — check `.env`; the error names the variable, never its value.                                                                                                                                   |
| `relation … does not exist`                                               | Migrations not applied: `pnpm --filter @habit/api db:migrate:deploy`.                                                                                                                                                                            |
| The worker exits with `ERR_MODULE_NOT_FOUND …/api/dist/…`                 | The API library is not built: `pnpm build:deps`.                                                                                                                                                                                                 |

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
