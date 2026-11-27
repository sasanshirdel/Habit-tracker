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
`WORKER_SHUTDOWN_TIMEOUT_MS`, `MAIL_TRANSPORT`, `MAIL_OUTBOX_DIR`, `MAIL_FROM`, `WEB_APP_URL`,
`LOG_LEVEL`, `LOG_FORMAT` (see `.env.example` and docs/DEVELOPMENT_WORKFLOW.md).

Queues consumed: `system` and, since P2-04, `email` (verification and "already registered"
emails, ADR-0021; password-reset links and "password changed" notices since P2-05, ADR-0022). Emails are only logged (`MAIL_TRANSPORT=log`, default) or written as JSON files
to a local directory (`MAIL_TRANSPORT=outbox` + `MAIL_OUTBOX_DIR`) — open the link from the file to
verify an account locally. No real email provider is configured yet. Invalid
configuration stops the process with exit code 1, naming the variable but never its value.

Logs are structured JSON lines on stdout (P1-07, ADR-0010), the same format as the API; lines
logged while a job runs carry `jobId`, `jobName` and `attempt` (never the payload).

Jobs it runs for the identity module: verification / password-reset / password-changed / account
deleted emails, and `identity.account-purge` (P2-10, ADR-0025), which erases accounts whose 30-day
restore window has passed. There is no job scheduler yet: until there is, the deployment must
enqueue `identity.account-purge` (empty payload, idempotent) once a day.

The worker has no health endpoint yet; liveness is the process itself. Job/queue monitoring arrives
with system management (P10-12) and observability (P12-05).

```bash
pnpm build:deps                                 # packages + API library (dist/)
pnpm --filter @habit/worker dev                 # build, then run with --watch on dist/
pnpm --filter @habit/worker build && pnpm --filter @habit/worker start
pnpm --filter @habit/worker test                # unit tests (lifecycle)
pnpm --filter @habit/worker test:integration    # real process vs real Redis (DATABASE_URL, REDIS_URL)
```
