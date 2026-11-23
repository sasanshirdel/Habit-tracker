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
pnpm --filter @habit/api dev         # :4000  GET /api/v1/health
pnpm --filter @habit/web dev         # :3000  /en  /fa
```

pnpm only runs install scripts for packages on the `allowBuilds` allow-list in
`pnpm-workspace.yaml`, and it refuses very new releases (minimum release age). If an install fails
with `ERR_PNPM_IGNORED_BUILDS`, review the package's script before adding it to the list.

## 2. Environment variables

Documented in [`.env.example`](../.env.example) (placeholders only). The API validates its env at boot
(`apps/api/src/config/env.ts`) and exits on invalid config without printing values.

| Variable                                                                | Used by        | Required                     | Description                             |
| ----------------------------------------------------------------------- | -------------- | ---------------------------- | --------------------------------------- |
| `NODE_ENV`                                                              | api            | no (`development`)           | `development` / `test` / `production`   |
| `API_PORT`                                                              | api            | no (`4000`)                  | HTTP port                               |
| `CORS_ORIGINS`                                                          | api            | no (`http://localhost:3000`) | Comma-separated allowed browser origins |
| `DATABASE_URL`                                                          | api, prisma    | Phase 1+                     | PostgreSQL connection string            |
| `REDIS_URL`                                                             | api, worker    | Phase 1+                     | Redis connection string                 |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | docker-compose | for `dev:services`           | Local dev database only                 |
| `REDIS_PORT`                                                            | docker-compose | no (`6379`)                  | Local Redis port                        |
| `NEXT_PUBLIC_API_BASE_URL`                                              | web            | Phase 1+                     | Public API base URL (never a secret)    |

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

| Command                                    | What it does                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm format:check`                        | Prettier (PRD file excluded — kept verbatim)                            |
| `pnpm lint`                                | ESLint 10 flat config (`@habit/config/eslint`, Next plugin for web)     |
| `pnpm typecheck`                           | `tsc --noEmit` per package (web runs `next typegen` first)              |
| `pnpm test`                                | Vitest per package                                                      |
| `pnpm build`                               | `tsc` (api, ui), `next build` (web)                                     |
| `pnpm check`                               | all of the above                                                        |
| `pnpm --filter @habit/api prisma:validate` | Prisma schema validation (needs `DATABASE_URL` set; no connection made) |

CI (`.github/workflows/ci.yml`) runs install (frozen lockfile), format, lint, typecheck, Prisma validate, test and build on every PR and every push to `main`.

## 7. Coding standards

- TypeScript strict, `noUncheckedIndexedAccess`; avoid `any`; prefer pure functions for domain logic.
- ESM; API relative imports end in `.js`.
- Pinned dependency versions; new dependencies need justification + ADR entry (version, date checked).
- API: module boundaries (ADR-0006), DTO validation, error codes, no Prisma entities in responses.
- UI: design tokens only, logical CSS, dictionaries for all strings, accessible components.
- Tests live next to code (`*.test.ts`) or in `apps/api/test/` for HTTP-level tests.
- Comments explain _why_, not _what_.

## 8. Agent workflow

AI agents follow [`AGENTS.md`](../AGENTS.md). Standard instructions the owner may give (PRD §14):
"Continue development", "Fix current issues", "Review architecture", "Implement a specific feature",
"Prepare for production". In all cases the agent inspects repository state first and never repeats completed work.
