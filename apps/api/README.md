# @habit/api

NestJS 12 (ESM) REST API — the modular monolith backend. Currently contains:

- `GET /api/v1/health` liveness and `GET /api/v1/health/ready` readiness (PostgreSQL + Redis checks; 503 when either is down)
- zod-validated environment configuration (`src/config/env.ts`) — the app fails fast on invalid config; `DATABASE_URL` and `REDIS_URL` are required (separate schema for the worker)
- `DatabaseModule` / `PrismaService` (`src/database/`) — Prisma 7 with the `pg` driver adapter
- Prisma schema (`prisma/schema.prisma`, `prisma.config.ts`) and migrations (`prisma/migrations/`, baseline only — **no product tables yet**)
- `QueueModule` (`src/queue/`, P1-03) — shared ioredis connection, `QueueProducer.enqueue(definition, payload)` (validates the payload, fails fast with `QUEUE_UNAVAILABLE` when Redis is down, optional idempotent `jobId`), job definitions via `defineJob`, Redis readiness check. Example job: `system.noop`.
- `WorkerModule` (`src/worker/`, P1-03) — consumers run by `apps/worker`: `JOB_HANDLERS`, payload re-validation (invalid/unknown jobs fail without retry), `WorkerHost` (one BullMQ worker per queue, graceful drain bounded by `WORKER_SHUTDOWN_TIMEOUT_MS`).

### Background jobs

A module that needs background work:

1. defines its job next to its code: `export const X_JOB = defineJob({ name: '<module>.<action>', queue: 'system', schema: z.strictObject({...}) })` — payloads carry **IDs and small parameters only**, never personal content (SECURITY.md);
2. enqueues from its service with `queueProducer.enqueue(X_JOB, payload, { jobId? })` and handles `QueueUnavailableError`;
3. implements a `JobHandler` (idempotent — a job can run more than once) and adds it to `JOB_HANDLERS` in `WorkerModule`.

Defaults: 3 attempts, exponential backoff from 1 s; failed jobs stay in the failed set for 7 days.

Package exports for `apps/worker`: `@habit/api/queue` and `@habit/api/worker` (built `dist/`, see ADR-0002 addendum).

```bash
pnpm --filter @habit/api dev                  # watch mode (nest CLI), regenerates the Prisma client
pnpm --filter @habit/api build                # prisma generate + tsc -> dist/
pnpm --filter @habit/api start                # node dist/main.js
pnpm --filter @habit/api test                 # vitest (unit + supertest e2e) — no database needed
pnpm --filter @habit/api test:integration     # real PostgreSQL (DATABASE_URL, throwaway DB) + Redis (REDIS_URL, per-run key prefix), incl. queue → worker
pnpm --filter @habit/api db:migrate:deploy    # apply migrations
pnpm --filter @habit/api db:migrate:dev --name <change>   # create a migration (local only)
DATABASE_URL=postgresql://... pnpm --filter @habit/api prisma:validate
```
