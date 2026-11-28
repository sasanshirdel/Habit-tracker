# ADR-0031: Occurrence statuses and check-ins — pure status rules, idempotent check-in operations

- **Status:** Accepted (P3-04)
- **Date:** 2026-11-28

## Context

Backlog P3-04 (#34): "Completed/Missed/Due/Skipped/Paused/NotScheduled semantics;
binary/numeric/duration/frequency/negative/custom completion rules", distinguishing unscheduled
from uncompleted, numeric/duration targets and partial progress, and an **idempotent check-in
endpoint (client op id)** with integration tests; security: owner-scoped writes and validated
numeric ranges. PRD §3.1 lists the six statuses and says "the backend must distinguish between an
uncompleted occurrence and an occurrence that was never scheduled"; it asks for grace-day
configurations and "historical editing with permission". PRD §6 names a `HabitCompletion` entity;
PRD §3.13/§8 ask for client-generated operation ids, server-side idempotency, version numbers and
"do not allow a stale offline client to silently overwrite newer server data".

Already decided: records are a value **or** a skip, unique per habit and local date, statuses are
computed and never stored, the version of a recorded day is derived from the version ranges
(ADR-0028); the engine gives each day a state `due` / `flexible` / `off` / `paused` / `inactive`
and prorated "N times per period" periods (ADR-0029); versions carry their targets, grace days and
calendar settings, and are changed only under a `FOR UPDATE` lock on the habit (ADR-0030).
ADR-0028 left grace-day semantics open, ADR-0029 open decision 5 asked how paused unscheduled days
show. P3-05 (#35, streaks/consistency) builds on these statuses; P3-06 (#36) owns habit CRUD
routes; Phase 8 owns offline sync.

## Decision

### 1. Status rules: a pure function in `@habit/habit-engine`

`computeStatuses({ habitType, startsOn, endsOn, archivedOn, versions (with target), pauses,
records, range, today })` (`packages/habit-engine/src/status.ts`) returns, per date of the range,
`{ status, timing, scheduleState, inactiveReason, pausedState, versionId, graceDays, record,
progress, openUntil, period }`, and the status of each "N times per period" period the range
touches. It is pure (today is an argument) so the API, the weekly matrix (P3-07) and later the
offline client derive the same answer. In order, first match wins:

| Engine state                                                        | Record / time                                                                          | Status                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| `inactive` (before start, after end, archived, no version) or `off` | anything (a value is reported as `progress`)                                           | **Not scheduled**                        |
| `paused` (pause or vacation), whatever the rule says                | anything (a value is reported as `progress`)                                           | **Paused**                               |
| `due`                                                               | skip                                                                                   | **Skipped**                              |
| `due`                                                               | value meets the target of the version in effect that day                               | **Completed**                            |
| `due`                                                               | `at_most` value above the limit                                                        | **Missed** (at once)                     |
| `due`                                                               | no record or not met, and `today > date + graceDays`                                   | **Missed**                               |
| `due`                                                               | no record or not met, `today ≤ date + graceDays` (today, future, or within grace)      | **Due**                                  |
| `flexible`                                                          | skip / met value                                                                       | **Skipped** / **Completed**              |
| `flexible`                                                          | not done: period met or nothing required / period closed short / period open and short | **Not scheduled** / **Missed** / **Due** |

- **Completion per type** (`judgeValue`): `binary`, `frequency` → value 1 (0 = recorded "not
  done"); `numeric`, `duration`, `custom at_least` → value ≥ target; `negative`, `custom at_most`
  → value ≤ target. Compared as integer thousandths (values have ≤ 3 decimals), so `7.999` vs `8`
  is exact. **Progress:** `{ value, target, met, partial, percent }` — `percent` =
  `floor(100 × value / target)` capped at 100 for "at least", 0/100 for done/limit kept.
  `partial` = some progress towards an "at least" target.
- **Not scheduled vs not done:** a day the engine does not schedule is Not scheduled even if a
  value was recorded on it (the value is still returned); a scheduled day without a record is Due
  or Missed — never Not scheduled.
- **Grace days** (ADR-0028 left their meaning open): the number of days after a scheduled day during
  which it is still **Due** (a late check-in still counts) before it becomes **Missed**; for a
  period, after its last day. `openUntil` tells the client the last such day. How streaks treat a
  still-open day is P3-05's (proposal: an open day neither extends nor breaks a streak).
- **"At most" limits** (negative habits, custom with `at_most`) are Missed as soon as the recorded
  value exceeds the limit — more lapses cannot undo it — and Completed while within it (the user
  confirms the day; a missing record is not assumed to be zero, see open decisions).
- **Paused unscheduled days** (ADR-0029 open decision 5): shown as **Paused** (a continuous pause
  in the matrix); `pausedState` keeps what the rule said, so streaks can tell.
- **Frequency habits are judged per period:** `completed` counts done values on every covered day
  of the period (paused days included — "did it anyway" counts), wherever the requested range
  ends; each **skip** on a flexible day excuses it like a one-day pause, so the period target is
  prorated again: `target = min(a, ceil(N × a / totalDays))` with `a = activeDays − skippedDays`
  (same formula as ADR-0029). Period status: `not_required` (target 0), `met`, `missed` (closed:
  `today > end + graceDays`), else `in_progress`. Undone days take the period's view (above), so
  a short week shows its undone days Missed; P3-05 should count frequency habits per period, not
  per day.
- **Timing** `past` / `today` / `future` is relative to the user's today; future scheduled days are
  Due.
- Callers pass every record of `statusRecordRange(input)` — the range widened to the whole weeks or
  months of its periods — so the answer never depends on the range (property-tested).

### 2. Check-in rules: also pure (`checkInRefusal`)

- **No day after today** — today = `localDateAt(now, profile time zone)` (ADR-0028). Time-zone
  edge: the profile zone decides, strictly; a user travelling ahead of it can check in their local
  "tomorrow" only once it is that date in the profile zone (or after updating the zone). Tolerating
  "+1 day" was rejected: it would let anyone pre-complete tomorrow. → `DATE_IN_FUTURE`.
- `set` and `skip` only on days the habit is **tracked** (not before its start, after its end,
  archived, or without a version) → `DATE_NOT_TRACKED`. Values may be recorded on `off` and
  `paused` days — what happened is never refused; the status stays Not scheduled / Paused.
- `skip` only on a scheduled, not paused day (`due` or `flexible`) → `SKIP_NOT_ALLOWED`.
- `clear` on any day up to today (it only removes what is there, e.g. a record left outside the
  habit's dates).
- **Past days** may be recorded back to the habit's start ("historical editing"): every change is
  in the append-only log with the user's `localToday`, and changes to past days are logged
  (`HabitCheckIn` logger: ids and dates, never values). A time limit or a paid restriction is an
  owner decision.
- **Archived habits are read-only** → `HABIT_ARCHIVED` (restore first, P3-06); deleted ones and
  other users' are "not found".
- **Values per type** (`occurrenceValueIssue`, the same rule as the database CHECK): 0/1 for binary
  and frequency, whole seconds ≤ 86 400 for duration, whole lapses for negative, 0..1 000 000 with
  ≤ 3 decimals for numeric/custom → `VALIDATION_FAILED` with `body.value`. A value is never
  bounded by the target (12 pages against a target of 10 is fine).

### 3. `HabitCheckInService` and the check-in log

- **Operation:** `{ operationId (client UUID), localDate, action: set|skip|clear, value?,
expectedVersion? }` (`habitCheckInSchema` in `@habit/shared-validation`; the web client
  generates `operationId` once per user action and reuses it for retries).
- **Transaction:** `SELECT … FROM habits … FOR UPDATE` (the lock schedule changes take, ADR-0030),
  so check-ins of one habit and its schedule changes run one after the other: the version in
  effect, the existing record and its `version` cannot change underneath, and there are no lost
  updates (eight simultaneous writes to one day → versions 1..8, tested). Different habits never
  wait for each other. A row lock was chosen over `INSERT … ON CONFLICT` tricks because the
  decision (refusals, conditional write, no-op detection, the version in effect) needs the
  locked state anyway; a habit is one user's, so contention is negligible.
- **Writes:** `set`/`skip` create the record (`version` 1) or update it (`version + 1`); `clear`
  deletes it. A request that asks for what is already stored changes nothing (`changed: false`,
  version unchanged) — "set the day's value" is naturally idempotent (ADR-0028).
- **Idempotency (client op id):** every accepted operation appends a row to **`habit_check_ins`**
  (PRD §6 `HabitCompletion`) with the operation id, unique per user. The same id again → the stored
  operation is returned with `replayed: true` and the day's **current** state — nothing is applied
  twice, even if the day changed since (an old retry never overwrites newer data). The same id
  with a different habit, day, action or value → `IDEMPOTENCY_KEY_REUSED` (409). Retries are first
  looked up without the lock (fast path), then again under the lock; two simultaneous requests
  with one id for two habits race on the unique index, and the loser is answered from the winner's
  row (tested: ten simultaneous copies → one write, nine replays). Replays are answered even after
  the habit was archived.
- **Conditional writes:** `expectedVersion` = the record version the client last saw (`null` = no
  record). If the stored record differs and the request would change it → `VERSION_CONFLICT` (409,
  `details.currentVersion`). A request that overwrites nothing is never a conflict; clearing a
  record that is already gone is not one either. Without `expectedVersion` the last write wins
  (online one-tap). Offline clients (Phase 8) **must** send it — PRD §8.
- **Version link:** the response reports `versionId` (the version in effect that day, from the
  engine) and judges the day against that version's target; it is not stored on the record or the
  log (ADR-0028).
- **Response** `HabitCheckInResult`: `{ replayed, checkIn, occurrence, day, period }`.

### 4. Routes (the issue asks for the endpoint)

| Route                                           | What                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `POST /api/v1/habits/{habitId}/check-ins`       | Apply one check-in operation (200 + result)                  |
| `GET /api/v1/habits/{habitId}/statuses?from&to` | Day statuses + periods, ≤ 366 days, archived habits readable |

Protected by the global `AuthGuard` (session; `POST` also CSRF), rate-limit class `default`
(per user), zod-validated params/body/query, owner-scoped (another user's habit → 404 like a
missing one), error envelope, OpenAPI (`HabitCheckInResult`, `HabitStatusRange`, …). Errors:
400 `VALIDATION_FAILED`, 404 `NOT_FOUND`, 409 `VERSION_CONFLICT` / `IDEMPOTENCY_KEY_REUSED` /
`HABIT_ARCHIVED`, 422 `DATE_IN_FUTURE` / `DATE_NOT_TRACKED` / `SKIP_NOT_ALLOWED` — six new
`ApiErrorCode`s with en/fa messages. Habit CRUD stays P3-06; this is the minimum the issue's
acceptance ("integration tests for endpoint") needs.

### 5. Table `habit_check_ins` (migration `20261128190000_habit_check_ins`)

`id`, `user_id`, `habit_id`, `habit_type` (composite FK `(habit_id, user_id, habit_type)` →
`habits`, ON DELETE CASCADE — other users' habits cannot be referenced), `operation_id` (unique with
`user_id`), `local_date`, `action` (enum `habit_check_in_action`), `value` (`numeric(12,3)`, exactly
for `set`, the occurrence value CHECK repeated verbatim — unit-tested), `changed`,
`occurrence_version` (null exactly for `clear`), `local_today`, `created_at`; index
`(habit_id, local_date)`. Append-only (`BEFORE UPDATE` trigger), cascades from `users` (purge)
and habits, in the export (`habits[].checkIns`). Additive only; tested from scratch and on top of
the previous release with existing records (no drift, no invented history). Rollback before real
data: drop the table, its trigger function and the enum.

## Alternatives considered

- **Statuses in the API module** — the web app's matrix and offline mode could not reuse them
  (ADR-0016); the engine package exists for exactly this (ADR-0029).
- **A stored status column / materialised occurrences** — rejected in ADR-0028.
- **Idempotency-Key header + a generic idempotency store (Redis)** — a header needs a CORS change,
  and a time-limited store would forget operations an offline queue may still retry; the log is
  user history the PRD wants anyway (`HabitCompletion`), and it is in the export.
- **Increment-style check-ins** ("+1 glass") — not idempotent without an op log; "set the day's
  value" plus the log gives both. A client can still add locally and send the new total with
  `expectedVersion`.
- **Missing record on a negative habit = success** — convenient for "don't smoke", but it would
  mark days the user never looked at as kept; explicit confirmation is the interim choice.
- **Per-day misses for frequency habits by shortfall only** (mark just `target − completed` days
  missed) — arbitrary about which days; the period status is the authoritative judgement.
- **Allow check-ins on the user's "tomorrow" (+14 h tolerance)** — lets users pre-complete days.
- **SERIALIZABLE / `ON CONFLICT` without a lock** — see "Transaction".

## Open decisions (interim choices, reversible; for the owner)

1. **Grace days** mean "days a missed scheduled day stays Due (late check-ins count)", per day and
   per period end.
2. **Negative / at-most habits need an explicit check-in** (a missing record is not "0 lapses");
   exceeding the limit is Missed at once.
3. **Values on unscheduled and paused days are accepted** and shown as progress, without changing
   the status; frequency completions on paused days count toward the period.
4. **Skips** only on scheduled, not paused days; for frequency habits a skip excuses the day and
   re-prorates the period target.
5. **Historical editing:** any day from the habit's start to today, no time limit, logged; archived
   habits are read-only.
6. **Time-zone edge:** today strictly in the profile time zone.
7. **Check-in log retention:** kept as long as the habit (export, purge by cascade); no pruning.
8. **Status range limit** 366 days per request.

## Consequences

- P3-05 computes streaks and consistency from `computeStatuses` (frequency habits per period;
  `pausedState`, `openUntil` and grace days are there for it). P3-07 reads
  `GET …/statuses` for a week and posts check-ins with a fresh `operationId` per tap. Phase 8
  queues the same operations offline with `expectedVersion`.
- Every writer of `habit_occurrences` must go through `HabitCheckInService` (lock + log); P3-06's
  archive/restore and start-date changes must take the same habit lock.
- Any change to the value rules must change `occurrenceValueIssue` and both CHECKs together (a
  unit test keeps the two CHECKs identical); `judgeValue` assumes values that passed them.

## Addendum (P3-06, ADR-0032)

- Archive, restore, delete and undelete take the same habit row lock (after the user's list lock),
  so a check-in is accepted wholly before an archive or refused `HABIT_ARCHIVED` after it
  (integration-tested). Restore is `POST /habits/{habitId}/restore`.
