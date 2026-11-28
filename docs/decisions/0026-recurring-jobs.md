# ADR-0026: Recurring jobs (job schedules)

- **Status:** Accepted (P2-10 / P2-08 follow-up)
- **Date:** 2026-11-28

## Context

Two shipped features owe a scheduled job, and both ADRs left it open because the platform could
only run jobs someone enqueued:

- **P2-10 (#30), ADR-0025:** "data is purged after grace" — the `identity.account-purge` job exists
  but nothing runs it; the deployment was told to enqueue it daily (ROADMAP #16, open decision 3).
- **P2-08 (#28), ADR-0023:** security events (180 days) and ended sessions (30 days) are purged
  **per account on write**, so accounts that never sign in again keep old rows; "a daily worker job
  … once scheduling is built" is owed. ADR-0017 indexed `user_tokens.expires_at` "for clean-up
  jobs" too.

Later phases need the same thing (reminder fan-out and digests in Phase 8, metric snapshots in
Phase 6, subscription renewals and reconciliation in Phase 9). Requirements: run each job at a
fixed time, **once per run across any number of worker replicas**, survive worker restarts and
downtime, no new infrastructure, no new dependency, and configuration in code (reviewed, versioned)
rather than in an operator's crontab.

## Decision

### BullMQ job schedulers, registered by the worker

- **Mechanism:** BullMQ's job schedulers (`Queue.upsertJobScheduler`, BullMQ 6.7.8 already in the
  API; cron via its bundled `cron-parser`). A scheduler is a Redis record keyed by a stable id that
  always keeps **one** delayed job for its next run, with a job id derived from the scheduler id and
  the run time (`repeat:<id>:<millis>`). When that job starts, BullMQ plans the following run.
- **Declaration (platform `src/queue/job-schedule.ts`):**
  `defineSchedule({ id, job, cron, payload, description })` next to the job, by the module that owns the work (ADR-0006). The id is
  `<module>.<action>`; `cron` is **five fields in UTC** from a deliberately small subset (numbers,
  ranges, lists, steps — no names, `L`, `W`, `#`, `?` or seconds), checked at definition time; the
  payload is validated against the job's schema at definition time, so an unhandleable schedule
  fails at startup.
- **Registration (`src/worker/job-schedules.service.ts`, `JobScheduleRegistrar`):** the worker
  collects `JOB_SCHEDULES` (feature modules contribute, like `JOB_HANDLERS`) and, in the
  background after bootstrap:
  1. refuses to start if a scheduled job has no handler in this worker or ids repeat;
  2. **creates** each missing scheduler and **re-registers** one whose cron, job, payload or job
     options differ from the declaration; a scheduler that already matches is **not touched**
     (an upsert re-plans the next run from _now_, which could move or repeat a run — found by the
     integration test);
  3. **removes** schedulers on our queues that are no longer declared, so renaming or deleting a
     schedule in code takes effect with the next deploy;
  4. repeats the check every hour, so a Redis that lost its data gets the schedules back without a
     restart.

  While Redis is down it retries with backoff (1 s doubling to 60 s), never blocks start-up, never
  crashes the worker, and logs only error codes; it stops before the worker drains on shutdown.
  Logs carry schedule ids and cron expressions only.

- **Once per run, across replicas:** every replica registers the same schedulers (atomic Redis
  scripts keyed by id; deterministic next-run job ids), so N replicas still have one pending job
  per run; BullMQ's job lock gives that job to exactly one worker. Delivery is **at least once**
  (a crash mid-run is recovered as a stalled job and retried), so scheduled handlers must be
  idempotent — both identity jobs are (batched, condition re-checked on delete).
- **Downtime:** a run whose time passed while no worker was up executes once when a worker
  returns (the pending job is simply due); missed days are not replayed one by one, which is right
  for clean-up jobs. Jobs that must not skip a period (Phase 6/9) must compute their own window
  from data, not from the run count.
- **A scheduled run is an ordinary job** of its definition: same queue, schema re-validation,
  retries/backoff from `JobDefinition.options`, failed-set retention, structured logs with
  `jobId`/`jobName`.
- **Switch:** `JOB_SCHEDULES_ENABLED` (worker, default `true`). `false` leaves Redis untouched —
  used by integration tests (a pending scheduled job would make "wait until the queue is idle"
  helpers wait forever) or a deployment that triggers the jobs elsewhere. Production must not turn
  it off without a replacement.

### Schedules today (all on the `system` queue, interim times)

| Schedule id                        | Job                          | Cron (UTC)    | Tehran | What it does                                                                                                                     |
| ---------------------------------- | ---------------------------- | ------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `identity.account-purge-daily`     | `identity.account-purge`     | `30 23 * * *` | 03:00  | Erases accounts whose 30-day restore window has passed (ADR-0025)                                                                |
| `identity.retention-cleanup-daily` | `identity.retention-cleanup` | `45 23 * * *` | 03:15  | Deletes security events older than 180 days, sessions ended more than 30 days ago, expired emailed-link tokens, for all accounts |

23:30 UTC is 03:00 in Tehran (no daylight saving) and night in Europe: the quietest hour for the
expected users. A deleted account is erased at most one day after its window closes; restore checks
the deadline itself, so a late purge never extends the window (ADR-0025).

### Global retention clean-up (closes ADR-0023's follow-up)

`IdentityRetentionService.cleanUp(now, batchSize = 1000)` deletes, in batches (`findMany` on an
indexed column, then `deleteMany` by id **with the condition repeated**, so a row that changed in
between survives):

- `user_security_events` with `created_at` older than 180 days (index `created_at`);
- `user_sessions` that ended more than 30 days ago — revoked, past `expires_at`, or idle past the
  idle timeout — using the **same predicate** (`endedBefore`) as the per-account purge on sign-in;
  new indexes `user_sessions(revoked_at)` and `user_sessions(last_used_at)` (additive migration
  `20261128090000_session_retention_indexes`) so this does not scan the table;
- `user_tokens` past `expires_at` (index from ADR-0017). An expired link is already rejected
  exactly like an unknown one (`INVALID_TOKEN`), so deleting it changes no behaviour.

The per-account purge on write stays (it keeps an active account's list tidy between runs). Counts
only are logged.

## Alternatives considered

- **External cron (Kubernetes CronJob / system cron) calling an "enqueue" script** — what ADR-0025
  asked deployments to do. Works, but the schedule lives outside the repo (not reviewed or tested),
  needs one per environment, and the hosting target is undecided (ROADMAP #3). Still possible with
  `JOB_SCHEDULES_ENABLED=false`.
- **Legacy BullMQ repeatable jobs (`queue.add(..., { repeat })`)** — deprecated in favour of job
  schedulers; keyed by a hash of the options, so changing a cron leaves the old repeat behind.
- **`@nestjs/schedule` (in-process timers) or `node-cron`** — new dependency, and every replica
  would fire; needs leader election or a Redis lock to run once. BullMQ already gives one pending
  job per run and a lock per job.
- **PostgreSQL `pg_cron`** — an extension the managed database may not offer, and business logic
  (cascades, logging, retries) would move into SQL or need a call back into the app.
- **A dedicated scheduler process (leader)** — one more deployable to run and monitor; nothing it
  adds over idempotent registration from every worker.
- **Upserting unconditionally on every sync** — simplest, but an upsert re-plans the next run from
  the current time: after an early manual run it re-queues the same run, and a sync just after a
  run's time could move it. Compare-then-upsert chosen.

## Open decisions (interim, reversible; for the owner)

1. **Run times:** 23:30 / 23:45 UTC (03:00 / 03:15 Tehran). Any fixed UTC time works.
2. **Retention values** remain those of ADR-0023 (events 180 days, ended sessions 30 days); expired
   emailed-link tokens are now deleted right after expiry (new, interim).
3. **Monitoring:** a failed scheduled run lands in the failed set (kept 7 days) and is logged; no
   alert exists until observability (P12-05) and the admin jobs view (P10-12). A "last successful
   run" check per schedule belongs there.

## Consequences

- ADR-0025 open decision 3 (purge not scheduled) and ADR-0023's "global retention job owed" are
  resolved; deployments no longer need to enqueue anything.
- New recurring work = `defineJob` + handler + `defineSchedule`, added to `JOB_HANDLERS` and
  `JOB_SCHEDULES` in `WorkerModule`; handlers must be idempotent and batch their writes.
- Every worker replica touches Redis once an hour for the check (a few commands per schedule).
- A schedule id is part of the Redis state: renaming one replaces the scheduler (the old pending
  run is dropped) on the next deploy.

## Addendum (P3-06, ADR-0032)

- The habits module declares `HABIT_SCHEDULES`: `habits.deleted-purge-daily` (job
  `habits.deleted-purge`, queue `system`, `55 23 * * *` UTC = 03:25 Tehran) erases habits deleted
  more than 30 days ago in batches. Registered by the worker next to `IDENTITY_SCHEDULES`.
