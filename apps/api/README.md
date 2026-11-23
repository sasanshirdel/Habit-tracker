# @habit/api

NestJS 12 (ESM) REST API — the modular monolith backend. Currently contains:

- `GET /api/v1/health` liveness and `GET /api/v1/health/ready` readiness (PostgreSQL + Redis checks; 503 when either is down)
- zod-validated environment configuration (`src/config/env.ts`) — the app fails fast on invalid config; `DATABASE_URL` and `REDIS_URL` are required (separate schema for the worker)
- `DatabaseModule` / `PrismaService` (`src/database/`) — Prisma 7 with the `pg` driver adapter
- Prisma schema (`prisma/schema.prisma`, `prisma.config.ts`) and migrations (`prisma/migrations/`, baseline only — **no product tables yet**)
- API conventions (`src/common/`, P1-05, ADR-0009): `requestIdMiddleware` (`x-request-id` on every response, `currentRequestId()`), global `AllExceptionsFilter` (`{ error: { code, message, details?, requestId } }`, `ApiException`), `ZodValidationPipe` (400 `VALIDATION_FAILED` with field-level issues), cursor pagination helpers (`paginate`, `encodeCursor`/`decodeCursor`, `sortSchema`); JSON body limit 100 kB. `configureApp()` applies them in `createApp` and in tests.
- Structured logging (`src/common/logging/`, P1-07, ADR-0010): `JsonLogger` is Nest's logger — JSON lines with `requestId`/`userId` (request) or `jobId`/`jobName`/`attempt` (job), one access line per request (`accessLogMiddleware`), mandatory redaction (`redact`, `scrubText`; error messages only with `NODE_ENV=development`), `LOG_LEVEL`/`LOG_FORMAT`. Keep using `new Logger(Context)`; log objects as `logger.log({ msg, ...fields })`; call `setRequestUserId(id)` once a user is authenticated (P2-03).
- Security (P1-08, ADR-0011): `securityHeadersMiddleware` (first middleware; deny-all CSP, HSTS, `nosniff`, `no-store`, …), CORS via `corsDelegate` (exact `CORS_ORIGINS`), `RateLimitModule` (`src/rate-limit/`): global guard with Redis counters — `default` on every route, add `@RateLimit('auth')` to credential/code endpoints and `@RateLimit('expensive')` to costly ones, `@SkipRateLimit()` for probes only; 429 `RATE_LIMITED` + `Retry-After`. Env: `RATE_LIMIT_ENABLED`, `RATE_LIMIT_PREFIX`, `TRUST_PROXY`. Tests swap the store for `MemoryRateLimitStore` (`overrideProvider(RATE_LIMIT_STORE)`).
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
