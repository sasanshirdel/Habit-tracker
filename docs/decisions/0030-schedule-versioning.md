# ADR-0030: Schedule versioning — new versions from an effective date, calendar settings per version, audited corrections

- **Status:** Accepted (P3-03)
- **Date:** 2026-11-28

## Context

Backlog P3-03 (#33): "changing a schedule closes the current version and opens a new one; past
occurrences keep their original rules", with "authorized historical corrections recorded with
audit metadata" (acceptance: editing a schedule never changes past statuses; corrections are
traceable; corrections permission-checked and logged). PRD §3.1 "Historical Integrity": schedule
changes must never silently rewrite history; a new version with an effective date per change;
"support authorized historical corrections and record them appropriately". ADR-0028 gave the
table (`habit_schedule_versions`, half-open `[effective_from, effective_to)`, `EXCLUDE` against
overlaps, the version of a recorded day derived from the ranges, never stored). ADR-0029 left
two questions for this item (ROADMAP #19 item 1): whether to snapshot the user's week start and
calendar on each version, and the default anchor of a new "every N days" rule.

## Decision

### A domain service in the habits module, no routes

`HabitScheduleService.changeSchedule(userId, habitId, request, { now? })` in
`apps/api/src/modules/habits` (internal; P3-06 adds the HTTP route, its error mapping and the
entitlement check). `request` is parsed with `habitScheduleChangeSchema`
(`@habit/shared-validation`): `{ schedule, target, graceDays, effectiveFrom?, expectedHabitVersion?, reason? }`.
The decision rules are a pure function, `planScheduleChange` (`schedule-versioning.ts`), so each
rule is unit-tested without a database; the service adds the transaction, the lock, "today" and
the integrity checks. `listChanges(userId, habitId)` returns a habit's audit trail.

### The rules (change effective from local date E)

| Situation                                                         | Result                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| No `effectiveFrom`                                                | E = the user's **today** (engine `localDateAt(now, profile time zone)`), or the habit's start if later |
| E before `starts_on` / after `ends_on`                            | refused: `EFFECTIVE_BEFORE_START` / `EFFECTIVE_AFTER_END` (changing the habit's dates is P3-06)        |
| Rules wrong for the stored type                                   | refused: `INVALID_RULES` with the `habitRuleIssues` (the type is immutable, ADR-0028)                  |
| New rules equal to those in effect on E (incl. calendar settings) | `unchanged`: nothing written, no audit entry, `habits.version` unchanged                               |
| The version V in effect on E **starts on E**                      | `replace`: V keeps its id and range, its rules are rewritten (the **same-day rule**)                   |
| V starts before E                                                 | `split`: V's `effective_to` = E (closed "the day before"), new version `[E, V's old end)`              |
| E later than today                                                | a **future-dated** change: today's rules stay until E                                                  |
| A version was already scheduled after E                           | it stays: the new version runs until it (a planned change is never dropped silently)                   |
| E **before today**                                                | a **historical correction**: needs `reason` (else `REASON_REQUIRED`); audited and logged (below)       |

- **Same-day rule, why replace:** a version that starts today (or later) has judged no finished
  day, so rewriting it loses nothing that was final — and two edits in one sitting do not leave
  a one-day version behind. Today's own record is re-judged, which is expected (the day is still
  running). A version that starts before today is never rewritten except by a correction.
- **Past days never move without a correction:** for E ≥ today every day before today keeps the
  version id it had, and every past version keeps its rules (a split only sets `effective_to` of
  the version in effect on E, which then still covers every day before E). A seeded property test
  checks this over random histories; an integration test checks the engine's day states for the
  past are identical before and after an edit ("editing a schedule never changes past statuses").
- **Corrections** re-judge recorded days in `[E, min(V's old end, today))` — that is their
  purpose ("we set this up with the wrong days"). They are allowed back to the habit's start,
  only for the owner (owner-scoped lookup; other users' habits are "not found"), only with a
  reason, and every one is recorded (audit row with before/after and the number of recorded days
  it re-judged) and logged (`HabitSchedule` logger: ids, dates and counts, no free text).
  Stricter policies (a time limit, refusing when recorded days are affected, a paid feature) are
  an owner decision — the `is_correction` flag and the count make any of them a small change.
- **Interval anchor:** an `interval` rule without `anchorDate` is anchored on E — "every N days
  from the day this version starts" (`resolveScheduleRule`; also for a new habit's first version,
  anchored on `starts_on`). An explicit anchor is kept, so a target-only change keeps the cadence.
- **Rules not fitting the version set** (overlap, invalid rule, no version on E): the planned
  result is checked with `@habit/habit-engine` before writing (`computeSchedule` refuses overlaps
  and bad rules; `versionIdOn(E)` must be the changed version and, for a split, `versionIdOn(E−1)`
  the closed one) → `INVALID_VERSIONS` / `NO_VERSION_ON_DATE`, which mean a bug or damaged data.
- **Orphans:** after writing, the service counts recorded days on dates no version covers; more
  than before → `ORPHANED_RECORDS` and the transaction rolls back. With the rules above (versions
  stay contiguous from the start) this cannot happen; it is defence in depth for later operations
  (P3-06 changing a habit's start, for example). Orphans that already existed do not block.

### Calendar settings per version (ROADMAP #19 item 1: interim decision, adopted)

- Two columns on `habit_schedule_versions`: `week_start` (`week_start` enum) and `calendar`
  (`calendar_system` enum), **NOT NULL without a default** — every writer snapshots the user's
  current `user_preferences` values explicitly (a forgotten snapshot fails loudly). The first
  version (habit creation), every split and every replace write the user's current settings.
- Consequence: changing the week start or calendar in Settings affects only versions written
  afterwards; past weeks and months are never re-bucketed (ADR-0029 "Calendar settings per
  version"). Re-saving the same rules after a preference change is not `unchanged`: it writes a
  new version with the new settings from E, which is how a user applies the new preference to an
  existing habit. A stored version is now an engine version as it is (`ScheduleVersionInput`).
- Backfill (migration): existing versions take their owner's current preferences — what callers
  were told to pass until the snapshot existed — or `gregorian` / `monday` (the `user_preferences`
  column defaults) for an account without a preferences row.
- Reversible: dropping the columns returns to "read the current preference" (ADR-0029's interim).

### Concurrency

- The transaction first takes `SELECT … FROM habits WHERE id = … AND user_id = … AND deleted_at
IS NULL FOR UPDATE`. Changes of one habit therefore run one after the other, and each plans
  against what the previous one committed (READ COMMITTED re-reads after the lock): six
  simultaneous future-dated edits produce six contiguous versions, four simultaneous edits of
  the same day one split and three replaces (integration tests).
- Optimistic check: `expectedHabitVersion` (the habit's `version`, ADR-0006/ADR-0028) must equal
  the stored value or the change is refused with `VERSION_CONFLICT`; every change increments
  `habits.version`. Two clients editing from the same version: exactly one wins (tested).
- Last line of defence: the `EXCLUDE` constraint and the unique `(habit_id, effective_from)`; a
  violation is reported as `VERSION_CONFLICT`. No SERIALIZABLE retries are needed.

### Audit trail: `habit_schedule_changes` (append-only)

| Column                          | Meaning                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `user_id`, `habit_id`           | Owner and habit; `(habit_id, user_id) → habits(id, user_id)` ON DELETE CASCADE                                        |
| `version_id`                    | The version created (create, split) or rewritten (replace); `(version_id, habit_id)` composite FK                     |
| `operation`                     | `create` · `split` · `replace` (new enum `habit_schedule_operation`)                                                  |
| `effective_from`, `local_today` | E and the user's local date when the change was made                                                                  |
| `is_correction`, `reason`       | CHECK: `is_correction = (operation <> 'create' AND effective_from < local_today)`; a correction has a reason (1..500) |
| `affected_recorded_days`        | Recorded days the change re-judged (0 unless a correction)                                                            |
| `before`, `after`               | JSONB arrays of version snapshots (the contract without `createdAt`); `before` null only for create                   |
| `created_at`                    | When                                                                                                                  |

- Written in the same transaction as the change (and by `HabitRepository.createHabit` for the
  first version). A `BEFORE UPDATE` trigger refuses any update (PRD §4.7 "protect audit records
  from ordinary modification"); rows go only with their habit or account (cascade = DELETE).
- The actor is the owner (customers can only change their own habits). Request context
  (request id) is in the log line of the HTTP request that P3-06 adds, not in the row.
- User-owned, so it is in the data export: each habit in the `habits` section now carries
  `scheduleChanges` next to `scheduleVersions` (whose entries now include `weekStart` and
  `calendar`), and the account purge removes it by cascade.

### Contracts and dependencies

- `@habit/shared-types`: `HabitScheduleVersion` gains `weekStart` and `calendar`; new
  `HabitScheduleChange`, `HabitScheduleOperation`, `HabitScheduleVersionSnapshot`,
  `HabitWeekStart`, `HabitCalendar`.
- `@habit/shared-validation`: `habitScheduleRuleDraftSchema` (interval anchor optional),
  `resolveScheduleRule`, `habitScheduleChangeSchema`, `habitScheduleChangeReasonSchema`,
  `HABIT_LIMITS.scheduleChangeReasonMaxLength` (500, = the CHECK; unit-tested).
- `apps/api` now uses `@habit/habit-engine` **at runtime** (`localDateAt`, `versionIdOn`,
  `computeSchedule`), so it moved from `devDependencies` to `dependencies`. The edge
  `@habit/api → @habit/habit-engine` was already allowed in `rules.js` (ADR-0029); no new
  third-party dependency.

### Migration `20261128170000_schedule_versioning`

Additive: one enum type, two columns added NULL-able → backfilled → `SET NOT NULL` (the table is
new since P3-01 and holds no production rows yet, so the rewrite-free `ADD COLUMN` plus an
`UPDATE` is cheap), a unique index `habit_schedule_versions(id, habit_id)` for the audit table's
composite key, the new table with indexes, foreign keys, CHECKs and the append-only trigger.
Tested: applied from scratch; applied on top of the previous release with versions of a Persian
account, an English account with Sunday weeks and an account without preferences (backfill
values, NOT NULL, no drift); a unit test keeps the SQL limits and the enum in step and asserts the
migration only adds (the only `UPDATE`s fill the two new columns). Rollback before real data:
drop the table, the trigger function, the enum, the index and the two columns.

## Alternatives considered

- **Always split, even on the same day** (zero-length or one-day versions) — the database refuses
  empty ranges, and one-day versions from "fix a typo" edits would clutter history and the
  matrix. Replace-in-place is safe because a version starting today has judged no finished day.
- **An edit replaces every later version** (drop planned future changes) — simpler ranges, but a
  silent loss of something the user scheduled. Rejected; cancelling a planned version is a
  separate operation (follow-up, P3-06 surface).
- **Store the version id on each occurrence** — rejected in ADR-0028 (second source of truth).
- **Forbid corrections that touch recorded days** — makes the PRD's "authorized historical
  corrections" nearly useless; instead they need a reason, are counted, audited and logged.
- **SERIALIZABLE isolation with retries** — works, but needs a retry loop around every change; a
  per-habit row lock is simpler and serialises exactly the conflicting writers.
- **Snapshot settings only for week/month kinds** — fewer non-null values, but kinds change
  between versions and NULL-handling spreads to every reader; two always-set columns are simpler.
- **A generic `audit_logs` table** — PRD §4.7 is about administrative events (Phase 10's admin
  audit log); user-facing schedule history belongs to the habits module and its export section.
- **Database defaults for the new columns** — would let a writer forget the snapshot silently.

## Open decisions (interim choices, reversible; for the owner)

1. **Snapshot week start and calendar per version** (ROADMAP #19 item 1) — adopted now as the
   recommended interim choice; a preference change applies to versions written afterwards.
2. **Correction policy:** owner-only, back to the habit's start, reason required (≤ 500), no time
   limit, allowed even when recorded days are re-judged (counted). Alternatives: a window (e.g.
   7 days), refusing when records are affected, or a paid entitlement.
3. **Same-day rule:** a version starting on the effective date is replaced in place.
4. **Edits keep later planned versions** (the new version runs until the next one).
5. **Archived habits** can have their schedule changed (they keep history and can be restored);
   deleted habits cannot ("not found").
6. **Interval anchor default** = the version's effective date (and `starts_on` for a new habit).

## Consequences

- P3-04 reads versions with their own `weekStart`/`calendar` and passes them to the engine as
  they are; statuses of past days cannot change through a schedule edit, only through an audited
  correction. P3-05 does the same for streaks and periods.
- P3-06 exposes `changeSchedule`/`listChanges` (routes, error codes → HTTP 409 for
  `VERSION_CONFLICT`, 400/422 for the rest, 404 for `HabitNotFoundError`), validates new habits'
  draft schedules, adds "cancel a planned version" if wanted, and must keep any change of a
  habit's `starts_on` consistent with its first version (the orphan check guards recorded days).
- Every writer of `habit_schedule_versions` must set `week_start`/`calendar` and append an audit
  row in the same transaction.

## Addendum (P3-04, ADR-0031)

- Check-ins take the same `FOR UPDATE` lock on the habit, so a check-in is always judged by a
  fully applied version set; schedule changes and check-ins of one habit run one after the other.

## Addendum (P3-06, ADR-0032)

- `HabitScheduleService.changeSchedule` is exposed as `POST /api/v1/habits/{habitId}/schedule-changes`
  (body = `habitScheduleChangeSchema`, answer `{ outcome, detail, change }`); refusals map to
  400 `VALIDATION_FAILED` on `body.<path>` / `body.effectiveFrom` / `body.reason`, 409
  `VERSION_CONFLICT`, 409 `HABIT_DATES_CONFLICT` (orphaned records).
- Habit start-date edits move the first version's `effective_from` under the same row lock
  (earlier: always; later: only if no recorded day and no later version falls before it). They are
  not audit-trail entries (logged instead).
