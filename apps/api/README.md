# @habit/api

NestJS 12 (ESM) REST API — the modular monolith backend. Currently contains:

- `GET /api/v1/health` liveness and `GET /api/v1/health/ready` readiness (database check; 503 when down)
- zod-validated environment configuration (`src/config/env.ts`) — the app fails fast on invalid config; `DATABASE_URL` is required
- `DatabaseModule` / `PrismaService` (`src/database/`) — Prisma 7 with the `pg` driver adapter
- Prisma schema (`prisma/schema.prisma`, `prisma.config.ts`) and migrations (`prisma/migrations/`, baseline only — **no product tables yet**)

```bash
pnpm --filter @habit/api dev                  # watch mode (nest CLI), regenerates the Prisma client
pnpm --filter @habit/api build                # prisma generate + tsc -> dist/
pnpm --filter @habit/api start                # node dist/main.js
pnpm --filter @habit/api test                 # vitest (unit + supertest e2e) — no database needed
pnpm --filter @habit/api test:integration     # real PostgreSQL (DATABASE_URL, throwaway DB) + Redis (REDIS_URL, per-run key prefix)
pnpm --filter @habit/api db:migrate:deploy    # apply migrations
pnpm --filter @habit/api db:migrate:dev --name <change>   # create a migration (local only)
DATABASE_URL=postgresql://... pnpm --filter @habit/api prisma:validate
```
