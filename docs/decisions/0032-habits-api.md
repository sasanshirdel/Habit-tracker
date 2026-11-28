# ADR-0032: Habits API — CRUD, archive/restore, soft delete, reorder, categories

- **Status:** Accepted (P3-06)
- **Date:** 2026-11-28

## Context

Backlog P3-06 (#36): "Habits API: CRUD, archive/restore, reorder, categories" — create habits of
all six types, list (archived excluded from active views), edit, archive, restore, delete,
reorder; categories; colours from the palette, icons, preferred times, targets/units; owner-scoped
everywhere with a cross-user test for every route. PRD §3.1 "Habit Management" lists create, edit,
archive, restore, delete, reorder, categories, icons, colours, targets and preferred times; PRD §6
asks for foreign keys and optimistic concurrency for offline edits; PRD §3.13/§8 for "do not let a
stale offline client silently overwrite newer server data". The owner ran the app and found there
was no way to create a habit: `GET`/`POST /api/v1/habits` answered 404.

Already decided: the tables (ADR-0028: `habit_categories`, `habits` with `position`, `version`,
`archived_at`, `deleted_at`; deleting a used category is refused by the database, `NO ACTION`),
the schedule engine (ADR-0029), schedule versioning with its row lock and optimistic
`habits.version` (ADR-0030, internal service only), check-ins and statuses under the same row lock
(ADR-0031). ADR-0028 left to P3-06: the reorder algorithm, the restore window and purge of deleted
habits, and what deleting a used category does. The API conventions are ADR-0009 (zod, error
envelope, keyset pagination), ADR-0012 (OpenAPI from zod), ADR-0019 (deny-by-default session +
CSRF, other users' rows → 404), ADR-0011 (rate-limit class `default` per user).

## Decision

### 1. Routes

Under `/api/v1`, all signed in (global `AuthGuard`), writes CSRF-protected, rate-limit class
`default`, bodies/queries validated with zod schemas from `@habit/shared-validation` (the web forms
reuse them), errors in the envelope, every operation in the OpenAPI document (tags `Habits`,
`Habit categories`):

| Operation                                        | Route                                                    |
| ------------------------------------------------ | -------------------------------------------------------- |
| `listHabits` (`status`, `categoryId`, paginated) | `GET /habits`                                            |
| `createHabit` (201)                              | `POST /habits`                                           |
| `reorderHabits`                                  | `PUT /habits/order`                                      |
| `getHabit`                                       | `GET /habits/{habitId}`                                  |
| `updateHabit` (metadata, start/end dates)        | `PATCH /habits/{habitId}`                                |
| `deleteHabit` (soft, 204)                        | `DELETE /habits/{habitId}?expectedVersion=`              |
| `archiveHabit`                                   | `POST /habits/{habitId}/archive?expectedVersion=`        |
| `restoreHabit` (un-archive)                      | `POST /habits/{habitId}/restore?expectedVersion=`        |
| `undeleteHabit` (within the restore window)      | `POST /habits/{habitId}/undelete?expectedVersion=`       |
| `changeHabitSchedule` (P3-03 rules over HTTP)    | `POST /habits/{habitId}/schedule-changes`                |
| `listHabitCategories` (paginated)                | `GET /habit-categories`                                  |
| `createHabitCategory` (201)                      | `POST /habit-categories`                                 |
| `reorderHabitCategories`                         | `PUT /habit-categories/order`                            |
| `updateHabitCategory` (rename / recolour / icon) | `PATCH /habit-categories/{categoryId}`                   |
| `deleteHabitCategory` (204)                      | `DELETE /habit-categories/{categoryId}?expectedVersion=` |

Every single-habit answer is a `HabitDetail`: the habit, all its schedule versions and
`currentVersionId` (the version in effect on the user's today in the profile time zone; before the
start the first, after the last version ends the last). Lists are `Paginated<…>` with keyset
cursors on `(position, id)`. Archive/restore/delete/undelete carry no body: `expectedVersion` is a
query parameter, like on `DELETE`.

### 2. Create

`POST /habits` takes `name`, `type`, `schedule` (interval anchor optional) and optionally
`description`, `unit`, `target`, `graceDays` (default 0), `categoryId`, `icon`, `color`,
`preferredTime`, `startsOn` (default: the user's today in the profile time zone), `endsOn`.
Type, unit and rules are checked together with the same table as the database CHECKs
(`habitRuleIssues`, `unitAllowedFor`). The habit and its first schedule version (snapshotting week
start and calendar, with its `create` audit entry) are written in one transaction by
`HabitRepository.createHabit` — the P3-03 path, not a second one. A new habit goes to the end of
the list (`max(position) + 1` over not-deleted habits, computed under the list lock). A
`categoryId` that is not one of the user's categories → 404 (the composite foreign key refuses it).

**`goalId`:** there is no goal column yet (goals are Phase 4). Bodies accept `goalId` only as
`null` (forward-compatible clients), responses do not carry it; Phase 4 adds the column and field.

**Colours** are names of a closed palette (`HABIT_COLOR_TOKENS`: slate, red, orange, amber,
yellow, lime, green, teal, cyan, sky, blue, indigo, violet, purple, pink, rose — interim, owner
decision); P3-07 maps each to light/dark tokens. The database still checks only the token shape,
so changing the list needs no migration. Icons stay free tokens (`^[a-z][a-z0-9-]*$`) until P3-07
picks an icon set.

**Entitlements** ("maximum active habits", PRD §3.14) are not enforced: plans are Phase 9. The
create path is the single place to add the check.

### 3. Edit

`PATCH /habits/{habitId}`: any non-empty subset of `name`, `description`, `unit` (must fit the
stored type), `categoryId`, `icon`, `color`, `preferredTime`, `startsOn`, `endsOn`; `null` clears
an optional field. Type is immutable; **schedule, target and grace days change only through
`POST /habits/{habitId}/schedule-changes`** (`HabitScheduleService.changeSchedule`, ADR-0030), so
history keeps its rules. The unit is a label (it does not change how values are judged), so it is
metadata.

**Start/end dates** (under the habit row lock):

- `startsOn` earlier → the first schedule version starts on the new day (the added days are judged
  by the first version's rules; logged). Interval anchors are stored, so the pattern does not move.
- `startsOn` later → refused with 409 `HABIT_DATES_CONFLICT` if recorded days lie before it
  (`reason: records_outside_dates`, `recordedDays`) or if a later version starts on or before it
  (`reason: schedule_versions` — deleting versions would also delete their audit entries, which
  cascade from versions).
- `endsOn` earlier → refused the same way if recorded days lie after it.
- `endsOn < startsOn` → 400 `VALIDATION_FAILED` on the field.

Date changes are not written to `habit_schedule_changes` (its operations are create/split/replace,
and its CHECKs tie them to version rows); they bump `habits.version`, update `updated_at` and are
logged (ids and dates only).

### 4. Optimistic concurrency

Every write takes an optional `expectedVersion` (the `habits.version` / `habit_categories.version`
the client saw; the schedule change keeps P3-03's `expectedHabitVersion`). A mismatch → 409
`VERSION_CONFLICT` with `details.currentVersion` — **except when the request would change
nothing**: archiving an archived habit, restoring an active one, deleting a deleted one inside the
window, undeleting a live one, or a PATCH whose values equal the stored ones are answered with the
current state and never conflict (same rule as ADR-0031's check-ins). Every real change bumps
`version`. **Reorders do not bump `version`:** the order is a property of the list, guarded by the
list check below; bumping every habit would make an unrelated offline metadata edit conflict.

### 5. Locks

Two locks, always in this order (`habit-locks.ts`):

1. the **user's list lock** — `pg_advisory_xact_lock(hashtextextended('habits:<userId>', 0))`
   (categories: `habit-categories:<userId>`) — for create, reorder, archive, restore, delete,
   undelete (and category create/delete/reorder);
2. the **habit row lock** — `SELECT … FOR UPDATE` on the habit, the lock schedule changes and
   check-ins take — for metadata and date edits, archive, restore, delete, undelete.

Writers that need only the row lock (check-ins, schedule changes, edits) never take the list lock,
so no cycle is possible. Consequences: an archive and a check-in of the same habit run one after
the other — the check-in is accepted before, refused `HABIT_ARCHIVED` after (tested 8 rounds);
reorders serialise with each other and with membership changes.

### 6. Reorder

`PUT /habits/order { habitIds }` must list **every active habit exactly once** (archived and
deleted habits are not part of the order). Under the list lock the server compares the set: an id
that is not one of the user's habits → 404; one of their archived habits, or a missing/extra
active one (the list changed since it was read) → 409 `ORDER_MISMATCH` (`expected`, `received`).
Positions become `0..n-1`; rows already in place are not written; writes go in id order.
Concurrent reorders therefore apply one after the other and the final order is exactly one of the
submitted orders (tested with 8 concurrent permutations); a reorder racing a create either sees the
new habit (and is refused) or leaves it last. Restored and undeleted active habits go to the end
(`max + 1`), so the active list never needs renumbering on archive. Categories use the same
algorithm (`PUT /habit-categories/order { categoryIds }`, every category once).

Rejected: fractional/lexicographic ranks with single-item moves (`{ before, after }`) — fewer
writes per move, but "the result is one of the submitted orders" is lost under concurrency, ranks
need rebalancing, and a full list is tiny (habits per user are tens).

### 7. Archive, restore, delete, purge

- **Archive** sets `archived_at`; archived habits leave every active view (`GET /habits` default),
  stay readable (`GET /habits/{id}`, statuses), are read-only for check-ins (ADR-0031) and may still
  be edited and change schedule (ADR-0030 #20).
- **Restore** clears `archived_at` and moves the habit to the end of the active list (the archived
  gap stays untracked, ADR-0029).
- **Delete** is soft (`deleted_at`): the habit answers 404 on every route, appears only in
  `GET /habits?status=deleted` and the data export, and can be **undeleted for 30 days**
  (`HABIT_DELETED_RESTORE_DAYS`, the account pattern of ADR-0025 — ADR-0028 open decision 4's
  proposal, interim). Undelete brings it back as it was (archived or active; active → end of the
  list). Past the window it is 404 everywhere.
- **Purge:** worker job `habits.deleted-purge`, scheduled daily at 23:55 UTC
  (`habits.deleted-purge-daily`, ADR-0026), hard-deletes habits deleted more than 30 days ago in
  batches; the database cascades to versions, audit trail, recorded days, check-in log, notes and
  pauses. The undelete checks the window itself, so a late purge never extends it.

### 8. Categories

Create (end of list), rename / recolour / icon (`PATCH`, no-op rule as habits), reorder, delete.
Names are unique per user case-insensitively (citext) → 409 `CATEGORY_NAME_TAKEN`. **Deleting a
category that active or archived habits use is refused** with 409 `CATEGORY_NOT_EMPTY`
(`details.habitCount`) — the database's `NO ACTION` stays the source of truth (a concurrent move
into the category makes the delete fail on the foreign key, mapped to the same code). Soft-deleted
habits in it are detached in the same transaction (undeleted later, they are uncategorised). This
**reverses ADR-0028 open decision 5's interim proposal** ("move them to uncategorised") on the
owner's instruction for this task; the choice stays with the owner (ROADMAP #18 item 5, #22).
Filtering the habit list by another user's category id simply lists nothing.

### 9. Errors

Four new codes, each with en + fa messages (`apiErrors.*`, parity enforced by the web test):
`CATEGORY_NOT_EMPTY`, `CATEGORY_NAME_TAKEN`, `ORDER_MISMATCH`, `HABIT_DATES_CONFLICT` (all 409).
Schedule-change refusals map onto fields: invalid rules → 400 `VALIDATION_FAILED` at
`body.<path>`, an effective date outside the habit → `body.effectiveFrom`, a correction without a
reason → `body.reason`; `VERSION_CONFLICT` → 409; a change that would orphan recorded days → 409
`HABIT_DATES_CONFLICT`; inconsistent stored versions stay a 500. Other users' habits and
categories → 404 `NOT_FOUND` on every route (also as `categoryId` in a body and inside a reorder).

### 10. Data export and account deletion

The `habits` export section already carries categories and every habit (archived and deleted ones
with `deletedAt`, now part of the `Habit` contract) with versions, audit trail and check-ins; the
account purge cascades through every habit table (tested again here with API-created data). No
schema change: **no migration in this PR.**

## Alternatives considered

- **`POST /habits/{id}/restore` for both archived and deleted habits** — one verb, but "restore"
  of a deleted habit that is also archived is ambiguous, and the PRD's archive/restore pair is a
  different action from undoing a delete. Two verbs (`restore`, `undelete`).
- **Hard delete** — simplest, but an accidental delete would erase history at once; the 30-day
  pattern matches accounts.
- **Move habits to "uncategorised" on category delete** (ADR-0028's proposal) — kept for the owner;
  refusing is the safer interim (nothing changes silently) and needs no data change.
- **Bodies `{ expectedVersion }` on archive/restore** — every request would need a JSON body, the
  OpenAPI generator marks bodies required; a query parameter matches `DELETE`.
- **Expose `expectedVersion` on schedule changes** under a new name — would break P3-03's schema;
  kept `expectedHabitVersion`.

## Open decisions (interim choices, reversible; for the owner — ROADMAP #22)

1. Deleted habits restorable for **30 days**, purged daily at 23:55 UTC.
2. Deleting a category with active or archived habits is **refused** (`CATEGORY_NOT_EMPTY`) —
   alternative: move them to uncategorised (ADR-0028 #5).
3. Colour palette: the 16 names above.
4. Moving `startsOn` earlier silently adds tracked (possibly Missed) days judged by the first
   version — alternative: treat it as a historical correction with a reason.
5. Reorders do not bump `version`; the order is last-writer-wins as a whole, guarded by the
   complete-list check.
6. No entitlement limit on active habits until Phase 9.

## Consequences

- P3-07 (habits UI) has every operation it needs; P3-05 streaks read the same rows.
- Phase 8 offline sync can send `expectedVersion` on every write and retry no-op writes safely.
- A future "move to uncategorised" category delete is a service change (no migration).
- Any new write path that changes a habit's state must take the row lock, and one that changes list
  membership or order the list lock first.
