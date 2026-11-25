# Development workflow

## 1. Local setup

| Tool             | Version                     | Notes                                   |
| ---------------- | --------------------------- | --------------------------------------- |
| Node.js          | 24 LTS (`.nvmrc` = 24.22.3) | `nvm use` / `fnm use`                   |
| pnpm             | 12.21.0 (`packageManager`)  | `corepack enable` or standalone install |
| Docker + Compose | recent                      | only for local Postgres/Redis           |

```bash
git clone git@github.com:sasanshirdel/Habit-tracker.git && cd Habit-tracker
cp .env.example .env
pnpm install
pnpm dev:services                    # postgres + redis on 127.0.0.1
pnpm --filter @habit/api db:migrate:deploy   # apply migrations to the local database
pnpm build:deps                      # build packages/* and the API library the worker imports
pnpm --filter @habit/api dev         # :4000  GET /api/v1/health, /api/v1/health/ready
pnpm --filter @habit/worker dev      # BullMQ consumers (rebuild the API with `pnpm --filter @habit/api build` after API changes)
pnpm --filter @habit/web dev         # :3000  / → /en or /fa (cookie, Accept-Language)
pnpm --filter @habit/web build && pnpm --filter @habit/web test:e2e   # route tests on next start
# Browser tests (ADR-0015): needs DATABASE_URL + REDIS_URL, the built API (build:deps) and Chromium
pnpm --filter @habit/web exec playwright install --only-shell chromium   # once per Playwright version
pnpm --filter @habit/web build:e2e && pnpm --filter @habit/web test:browser
```

pnpm only runs install scripts for packages on the `allowBuilds` allow-list in
`pnpm-workspace.yaml`, and it refuses very new releases (minimum release age). If an install fails
with `ERR_PNPM_IGNORED_BUILDS`, review the package's script before adding it to the list.

## 2. Environment variables

Documented in [`.env.example`](../.env.example) (placeholders only). The API and the worker validate
their env at boot (`apps/api/src/config/env.ts`) and exit on invalid config without printing values.

| Variable                                                                | Used by             | Required                         | Description                                      |
| ----------------------------------------------------------------------- | ------------------- | -------------------------------- | ------------------------------------------------ |
| `NODE_ENV`                                                              | api, worker         | no (`development`)               | `development` / `test` / `production`            |
| `API_PORT`                                                              | api                 | no (`4000`)                      | HTTP port                                        |
| `CORS_ORIGINS`                                                          | api                 | no (`http://localhost:3000`)     | Comma-separated allowed browser origins          |
| `RATE_LIMIT_ENABLED`                                                    | api                 | no (`true`)                      | `false` only for local load tests (P1-08)        |
| `RATE_LIMIT_PREFIX`                                                     | api                 | no (`habit:rl`)                  | Namespace of rate-limit counter keys in Redis    |
| `TRUST_PROXY`                                                           | api                 | no (`0`, 0–5)                    | Trusted reverse-proxy hops for the client IP     |
| `API_DOCS_ENABLED`                                                      | api                 | no (on unless production)        | Serve `/api/docs/openapi.json` (P1-06, ADR-0012) |
| `DATABASE_URL`                                                          | api, worker, prisma | **yes** (refuses to boot)        | PostgreSQL URL (`postgres://` / `postgresql://`) |
| `REDIS_URL`                                                             | api, worker         | **yes** (refuses to boot, P1-03) | Redis URL (`redis://`, or `rediss://` for TLS)   |
| `QUEUE_PREFIX`                                                          | api, worker         | no (`habit:q`)                   | Namespace of all BullMQ keys                     |
| `WORKER_CONCURRENCY`                                                    | worker              | no (`5`, 1–50)                   | Parallel jobs per queue per worker process       |
| `WORKER_SHUTDOWN_TIMEOUT_MS`                                            | worker              | no (`25000`, 1000–600000)        | Graceful-shutdown wait for in-flight jobs        |
| `LOG_LEVEL`                                                             | api, worker         | no (`debug` in dev, else `info`) | `trace`/`debug`/`info`/`warn`/`error`/`fatal`    |
| `LOG_FORMAT`                                                            | api, worker         | no (`json`)                      | `json` (one object per line) or `pretty` (local) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | docker-compose      | for `dev:services`               | Local dev database only                          |
| `REDIS_PORT`                                                            | docker-compose      | no (`6379`)                      | Local Redis port                                 |
| `NEXT_PUBLIC_API_BASE_URL`                                              | web                 | Phase 1+                         | Public API base URL (never a secret)             |

Every new variable must be added to `.env.example`, this table, and the env schema in the same PR.

## 3. Branches

- `main` is protected and always releasable. Nobody (human or agent) pushes to it directly.
- Short-lived branches from `main`: `feature/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `phase-N/<slug>` (ADR-0008).
- Rebase on `main` before requesting review; squash-merge.

## 4. Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`
Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`. Scopes: `web`, `api`, `ui`, `config`, `db`, `ci`, module names.
Small, logical commits; no secrets; no generated artefacts (`dist`, `.next`).

## 5. Issues → PRs

1. Work starts from a GitHub Issue (labels `phase:N`, `area:*`, `type:*`). The full backlog is in [`backlog/`](backlog/).
2. Branch, implement, test, update docs.
3. Open a PR with the template: summary, linked issue (`Closes #N`), checks actually run with results, security/data impact, limitations.
4. CI `verify` must pass; owner review required; human approval for PRD §13.5 items.

## 6. Checks

| Command                                    | What it does                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                        | Prettier (PRD file excluded — kept verbatim)                                                        |
| `pnpm build:packages`                      | Build `packages/*` in dependency order                                                              |
| `pnpm build:deps`                          | `build:packages` + build the API library imported by `apps/worker` (run by `typecheck`/`test`)      |
| `pnpm lint`                                | ESLint 10 (`@habit/config/eslint`, Next plugin for web) + architecture check (ADR-0016)             |
| `pnpm typecheck`                           | `tsc --noEmit` per package (web runs `next typegen` first)                                          |
| `pnpm test`                                | Vitest per package                                                                                  |
| `pnpm build`                               | `tsc` (api, ui), `next build` (web)                                                                 |
| `pnpm check`                               | all of the above                                                                                    |
| `pnpm --filter @habit/api prisma:validate` | Prisma schema validation (needs `DATABASE_URL` set; no connection made)                             |
| `pnpm test:integration`                    | Integration tests against real PostgreSQL + Redis (needs `DATABASE_URL` and `REDIS_URL`, see below) |

Shared packages are consumed through their built `dist/`; after a fresh clone or when editing
a package, run `pnpm build:deps` (or any root `typecheck`/`test`) before starting an app in
dev mode. The same holds for `apps/worker`, which imports the API through `@habit/api/worker` and
`@habit/api/queue` (the API's `dist/`, ADR-0002 addendum).

`pnpm test` never needs a database or Redis (the API's unit/HTTP tests point `DATABASE_URL` and
`REDIS_URL` at closed ports and exercise readiness and enqueueing in their "down" state). The API's `build`/`typecheck`/`test`/`dev` scripts run
`prisma generate` first; the generated client (`apps/api/src/generated/`) is git-ignored.

### Database & migrations

| Command (in `apps/api`, or `pnpm --filter @habit/api …`) | What it does                                                |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm db:migrate:dev --name <change>`                    | Create + apply a migration from schema changes (local only) |
| `pnpm db:migrate:deploy`                                 | Apply pending migrations (CI, staging, production)          |
| `pnpm db:migrate:status`                                 | Show applied/pending migrations                             |

Prisma CLI commands and the API load the repository-root `.env` when `DATABASE_URL` is not already
set in the environment. `migrate dev` needs a role that may create databases (shadow database); the
docker-compose user can. Never run `migrate dev`/`migrate reset` against shared or production
databases; destructive migrations need explicit owner approval (PRD §13.5).

Integration tests (`apps/api/test/**/*.int.test.ts`) create a throwaway database next to the one in
`DATABASE_URL`, apply migrations with `prisma migrate deploy`, run, and drop it — the database in
`DATABASE_URL` itself is not modified. They also need Redis (`REDIS_URL`): every key they write is
under a per-run prefix `habit:it:<run>:` that global teardown deletes (SCAN + DEL — never
`FLUSHDB`), so a shared dev Redis is safe. Redis must use `maxmemory-policy noeviction` (BullMQ
requirement; docker-compose sets it, and it is the Redis default) — a test asserts this. Setup fails
fast with a clear message if either variable is missing or Redis is unreachable. Queue keys created
by the apps the tests boot use `QUEUE_PREFIX=habit:it:<run>:q`, so they are removed with the rest.

The worker's integration test (`apps/worker/test/*.int.test.ts`) builds the worker and runs
`dist/main.js` as a real process: a producer enqueues `system.noop`, the worker completes it, and a
SIGTERM during a slow job must let it finish and exit 0. It uses its own `habit:it:w<run>:` prefix
and deletes it afterwards. With docker-compose running:

```bash
# uses DATABASE_URL / REDIS_URL from the environment (CI) or export them from .env
pnpm test:integration
```

Without Docker, any local PostgreSQL 18 works (e.g. PGDG packages); create a role with
`LOGIN CREATEDB` and point `DATABASE_URL` at it. For Redis, any Redis ≥ 8 works (e.g. the distro
`redis-server` package started on 127.0.0.1).

CI (`.github/workflows/ci.yml`) runs install (frozen lockfile), format, lint, typecheck, Prisma validate, test and build on every PR and every push to `main` (job `verify`), and the integration job (`integration`, check name `integration · PostgreSQL + Redis`: Postgres 18.7 and Redis 8.8.4 service containers with throwaway credentials, `migrate deploy`, `migrate status`, `pnpm test:integration`, then a check that no throwaway databases or `habit:it:*` keys were left behind). The two jobs are independent; `verify` never needs a database or Redis.

## 7. Coding standards

- TypeScript strict, `noUncheckedIndexedAccess`; avoid `any`; prefer pure functions for domain logic.
- ESM; API relative imports end in `.js`.
- Pinned dependency versions; new dependencies need justification + ADR entry (version, date checked).
- Workspace and module boundaries are checked by `pnpm check:architecture` (part of `pnpm lint`; ARCHITECTURE §2.1, ADR-0016).
- API: module boundaries (ADR-0006), zod validation per parameter (`ZodValidationPipe`), errors via `ApiException` with an `ApiErrorCode`, cursor pagination for lists (ADR-0009), no Prisma entities in responses.
- UI: design tokens only, logical CSS, dictionaries for all strings, accessible components.
- Tests live next to code (`*.test.ts`) or in `apps/api/test/` for HTTP-level tests.
- Comments explain _why_, not _what_.

## 8. Agent workflow

AI agents follow [`AGENTS.md`](../AGENTS.md). Standard instructions the owner may give (PRD §14):
"Continue development", "Fix current issues", "Review architecture", "Implement a specific feature",
"Prepare for production". In all cases the agent inspects repository state first and never repeats completed work.
