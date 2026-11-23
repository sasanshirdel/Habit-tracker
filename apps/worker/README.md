# @habit/worker

Background worker process (backlog P1-03). Runs the BullMQ consumers for the API's queues as a
separate process built from the same codebase (ARCHITECTURE §1, ADR-0006):

- the worker module, job handlers and queue definitions live in `apps/api` (`src/worker/`,
  `src/queue/`) and are imported through the API's package exports `@habit/api/worker` and
  `@habit/api/queue` (built `dist/`, ADR-0002 addendum);
- this app owns only the process lifecycle (`src/main.ts`, `src/lifecycle.ts`): boot a Nest
  application context (no HTTP server), and on `SIGTERM`/`SIGINT` drain in-flight jobs (bounded by
  `WORKER_SHUTDOWN_TIMEOUT_MS`), close connections and exit `0`; a second signal exits `1`
  immediately. Jobs cut off by a timeout or crash are recovered by BullMQ as stalled and retried.

Configuration: `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `QUEUE_PREFIX`, `WORKER_CONCURRENCY`,
`WORKER_SHUTDOWN_TIMEOUT_MS` (see `.env.example` and docs/DEVELOPMENT_WORKFLOW.md). Invalid
configuration stops the process with exit code 1, naming the variable but never its value.

The worker has no health endpoint yet; liveness is the process itself. Job/queue monitoring arrives
with system management (P10-12) and observability (P12-05).

```bash
pnpm build:deps                                 # packages + API library (dist/)
pnpm --filter @habit/worker dev                 # build, then run with --watch on dist/
pnpm --filter @habit/worker build && pnpm --filter @habit/worker start
pnpm --filter @habit/worker test                # unit tests (lifecycle)
pnpm --filter @habit/worker test:integration    # real process vs real Redis (DATABASE_URL, REDIS_URL)
```
