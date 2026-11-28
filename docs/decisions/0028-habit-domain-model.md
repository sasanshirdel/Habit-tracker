# ADR-0028: Habit domain model — habits, categories, schedule versions, recorded occurrences

- **Status:** Accepted (P3-01)
- **Date:** 2026-11-28

## Context

Backlog P3-01 (#31) opens Phase 3: the tables everything else in the habit area builds on — the
schedule engine (P3-02, pure library), schedule versioning (P3-03), occurrence status and
completion (P3-04), streaks and consistency (P3-05), the habits API (P3-06) and the weekly matrix
(P3-07). PRD §3.1 asks for six habit types with type-specific input and completion logic; daily,
weekday, weekly-frequency, monthly, interval and flexible schedules with start/end dates, pauses,
vacations and grace days; six occurrence statuses with "not scheduled" distinct from "not done";
schedule changes that never rewrite history (versions with an effective date); archive, restore,
delete, reorder, categories, icons, colours, targets and preferred times. PRD §6 asks for foreign
keys, unique constraints, duplicate-occurrence prevention, history preservation, soft deletion and
correct time-zone handling; PRD §8 for version numbers on offline-editable entities. ADR-0006 fixes
the conventions (UUIDv7, UTC instants + IANA zone, local-date keys, `version` columns), ADR-0024
makes the calendar (Gregorian / Solar Hijri) and week start display preferences, and ADR-0025
requires every user-owned table to cascade from `users` and to be in the data export.

## Decision

### Tables (migration `20261128150000_habit_domain_model`, owned by the new `habits` module)

| Table                     | Holds                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `habit_categories`        | The user's categories: name (citext, unique per user), palette/icon tokens, position, version                                      |
| `habits`                  | Type, name, description, unit, icon, colour, `starts_on`/`ends_on`, preferred time, position, version, `archived_at`, `deleted_at` |
| `habit_schedule_versions` | One version of a habit's rules for local dates `[effective_from, effective_to)`: schedule kind and its fields, target, grace days  |
| `habit_occurrences`       | What the user recorded for one habit on one local date: a value **or** a skip; version                                             |
| `habit_notes`             | Notes on a habit, optionally about one local date; version                                                                         |
| `habit_pauses`            | A pause of one habit, or a vacation of all habits (`habit_id` null), inclusive local dates                                         |

PRD §6's `HabitCompletion` (individual check-in events) and `HabitTemplate` are **not** created
here: check-in idempotency and events belong to P3-04, templates to P3-10.

### Calendar days are local `date` values; Solar Hijri only at the edges

- Every calendar day (start/end dates, effective dates, occurrence and note days, pause ranges,
  interval anchors) is a PostgreSQL `date` holding the **user's local date** as an ISO/Gregorian
  `YYYY-MM-DD`. Instants (`created_at`, `archived_at`, …) stay `timestamptz(3)` UTC (ADR-0006).
- No time zone is stored per row. "Which day is today" is decided when writing, from the user's
  IANA zone in `user_preferences` (P3-04 validates a check-in's local date against it); a stored
  local date never moves when the user travels or changes zone, and DST cannot shift it.
- Solar Hijri is never stored: the API and database speak Gregorian ISO dates, clients convert
  at display/input time with `Intl` (`calendar: 'persian'`, ADR-0024). Weekdays are ISO numbers
  (1 = Monday … 7 = Sunday) independent of the user's week start, which is display only.
- Supported window `2000-01-01`..`2099-12-31` (`HABIT_DATE_MIN`/`MAX`), checked everywhere.
- In TypeScript, `toDbDate`/`fromDbDate` in the habits module are the only conversions (Prisma
  maps `date` to a `Date` at UTC midnight); nothing else may build a `Date` from a local date.

### Habit types (immutable) and targets

| Type        | Recorded value per day | Target (on the schedule version)                                                                                                | Unit           |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `binary`    | 1 done / 0 not done    | none                                                                                                                            | none           |
| `frequency` | 1 / 0                  | none — the target is `times_per_period` of the schedule (kind `times_per_period` is required, and only frequency habits use it) | none           |
| `numeric`   | amount                 | `at_least` > 0                                                                                                                  | optional       |
| `duration`  | whole seconds ≤ 86 400 | `at_least`, whole seconds 1..86 400                                                                                             | none (seconds) |
| `negative`  | whole lapses           | `at_most` ≥ 0 (usually 0)                                                                                                       | optional       |
| `custom`    | amount                 | `at_least` > 0 or `at_most` ≥ 0                                                                                                 | required       |

- Values and targets are `numeric(12,3)`, 0..1 000 000 (never floats in the database).
- **The type never changes.** Schedule versions and occurrences carry a copy of the habit's type
  inside their composite foreign key `(habit_id, user_id, habit_type) → habits(id, user_id, type)`
  with `ON UPDATE NO ACTION`. That one key (a) makes changing a habit's type impossible once it has
  rows (and every habit gets its first version in the creating transaction), and (b) lets plain
  CHECK constraints validate type-specific targets and values. Changing type = a new habit.
- **Targets live on the schedule version**, not the habit: raising "8 glasses" to "10 glasses" is
  a new version, so past days are still judged against 8 (PRD "historical occurrences must retain
  the rules that applied"). The unit is a label on the habit.

### Schedules: typed columns per kind, versions that never overlap

- `kind` ∈ `daily`, `weekdays` (`days_of_week` ISO 1..7), `monthly_days` (`days_of_month` 1..31,
  -1 = last day), `interval` (`interval_days` 2..365 from `anchor_date`), `times_per_period`
  (`period` week|month, `times_per_period` 1..7 | 1..31). Unused fields are empty/NULL; one CHECK
  (`habit_schedule_versions_rule_check`) allows exactly the fields of the row's kind. Pause,
  vacation and start/end handling are separate rows/columns, not schedule kinds. `grace_days`
  (0..7) is stored per version; its exact semantics (window, interaction with streaks) are P3-05's.
- Versions cover half-open ranges `[effective_from, effective_to)`; `effective_to` NULL = current.
  `EXCLUDE USING gist (habit_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)`
  (extension `btree_gist`, trusted since PostgreSQL 13) makes overlapping versions — including two
  open ones — impossible. P3-03 closes the current version and opens the next in one transaction;
  past versions are never edited.
- The version that applies to a recorded day is **derived** (the one whose range contains the
  date), not stored on the occurrence: past ranges are immutable, so the answer cannot change, and
  storing it would be a second source of truth that could disagree (refines ADR-0006 — addendum).

### Occurrences are records, statuses are computed

- A `habit_occurrences` row exists only where the user recorded something: `value` (per the table
  above) or `skipped = true` (exactly one of the two, CHECK). Unique `(habit_id, local_date)`
  makes duplicate days impossible. Index `(user_id, local_date)` serves a week of all habits.
- **No status column.** Completed / Missed / Due / Skipped / Paused / Not scheduled
  (`HabitOccurrenceStatus` in `@habit/shared-types`) are computed by P3-04 from the schedule engine
  (P3-02), the version in effect, pauses and the record — so "not scheduled" vs "not done" is a
  property of the computation, and no derived value is the only source of truth (PRD §6).
- Writes are "set the day's value" (naturally idempotent, conflict-checked by `version`) — the
  recommended shape for P3-04/P8; increment-style check-ins with client operation ids, if needed,
  get their own table in P3-04.

### Ownership, deletion, ordering, concurrency

- Every table has `user_id → users(id) ON DELETE CASCADE` (the account purge, ADR-0025) and an
  index usable for it. Children reach their habit through keys that include `user_id`
  (`habits(id, user_id)` / `(id, user_id, type)` unique), and a habit's category through
  `(category_id, user_id) → habit_categories(id, user_id)`, so a row can never reference another
  user's habit or category — the database refuses it, not only the repository.
- Deleting a category that habits still use is refused (`NO ACTION`); P3-06 moves those habits to
  "uncategorised" in the same transaction. (`ON DELETE SET NULL (category_id)` would do it in the
  database, but Prisma cannot express the column list and would report schema drift.)
- Habits: `archived_at` (out of active views, restorable) and `deleted_at` (soft delete; hidden
  everywhere but the export; how long it stays restorable and the purge are P3-06's decision).
  Categories, versions, occurrences, notes and pauses are hard-deleted or cascade.
- `position` (integer ≥ 0, ties by id) on habits and categories; the reorder algorithm is P3-06's.
- `version` (integer ≥ 1) on habits, categories, occurrences and notes for offline conflict
  detection (ADR-0006, Phase 8); writers increment it.
- Text rules match `@habit/shared-validation` (`HABIT_LIMITS`): names NFKC-normalised single line
  without control/bidi-override characters (as display names, ADR-0024); descriptions and notes
  multi-line NFC; colours and icons are design tokens (`^[a-z][a-z0-9-]*$`), never raw colours.

### Code

- `@habit/shared-validation` (`habits.ts`): enums, `HABIT_LIMITS`, date window, text/token/date
  schemas, `habitScheduleRuleSchema` (canonicalises day lists), `habitTargetSchema`,
  `habitDefinitionSchema` (type + unit + rules checked together via `habitRuleIssues`, the same
  table as the database CHECKs), `habitOccurrenceEntrySchema`, `occurrenceValueIssue`,
  preferred-time helpers (`HH:MM` ↔ minutes).
- `@habit/shared-types` (`habits.ts`): `Habit`, `HabitCategory`, `HabitScheduleVersion`,
  `HabitScheduleRule`, `HabitTarget`, `HabitOccurrenceRecord`, `HabitOccurrenceStatus`,
  `HabitNote`, `HabitPause`.
- API `src/modules/habits`: `HabitsModule` (no controller — P3-06 adds routes), owner-scoped
  `HabitRepository` (create with first version in one transaction, find, list active, list
  categories, list occurrences in a date range; another user's category → `HabitCategoryNotFoundError`),
  row ↔ contract mappers, and `HabitsDataExportContributor` (export section `habits`: categories,
  habits incl. archived/deleted with all schedule versions, occurrences, notes, pauses).
- Constraints Prisma cannot express (CHECKs, EXCLUDE, the extension) are hand-written at the end of
  the migration; `prisma migrate diff` reports no drift (tested). A unit test keeps the SQL bounds,
  enums and shared lists in step.

### Migration safety

Additive only (extension, 4 enum types, 6 tables, their indexes and constraints; no existing table
altered — unit-tested). Applied from an empty database and on top of the previous release
(generic upgrade + drift test). Rollback before real data: drop the six tables and four types.

## Alternatives considered

- **Materialise an occurrence row for every scheduled day** — simple reads, but every schedule
  edit would rewrite future rows, pauses would need row updates, and storage grows with time even
  for untouched habits; the PRD's "not scheduled vs not done" would depend on a generation job
  having run. Computing from versions (ARCHITECTURE §4 "pure, deterministic function") instead.
- **Store the schedule as JSONB** — flexible and one column, but the database could no longer
  enforce its shape, and every reader parses. Typed columns + one CHECK are still additive to
  extend (a new kind = new enum value and columns). Revisit if kinds multiply.
- **Store occurrence dates as UTC instants or with a per-row zone** — "today" would move with
  zone changes and DST; the PRD's day-based habits need the user's calendar day. Rejected.
- **Store Solar Hijri dates for Persian users** — two calendars in storage, conversions in SQL,
  queries that differ by user. Rejected; Hijri is a display concern (ADR-0024).
- **Status column on occurrences** — a derived value as the source of truth, wrong after a target
  or schedule change. Rejected.
- **Targets on the habit** — editing a target would silently re-judge history. Rejected.
- **Enforce non-overlapping versions in application code or with a trigger** — racy (application)
  or invisible to readers (trigger); `EXCLUDE` is declarative and atomic.
- **Partial unique index "one open version per habit"** — needs Prisma's `partialIndexes` preview
  or causes drift; the exclusion constraint already covers it.

## Open decisions (interim choices, reversible; for the owner)

1. **`frequency` ⇔ times-per-period:** only frequency habits use "N times per week/month", and
   frequency habits use nothing else. Measurable habits with a weekly count ("run 5 km 3×/week")
   are not modelled yet (relaxing the CHECK is additive later).
2. **Negative habits** count whole lapses per day against an `at_most` target (default 0); time
   limits ("≤ 30 min social media") are `custom` with `at_most`.
3. **Supported dates** 2000-01-01..2099-12-31; **values** up to 1 000 000 with 3 decimals;
   durations as whole seconds within a day; grace days 0..7 (meaning defined in P3-05).
4. **Deleted habits** are soft-deleted; restore window and purge are P3-06's (proposal: same
   30-day pattern as accounts).
5. **Category deletion** with habits in it moves them to "uncategorised" (P3-06) rather than
   blocking.

## Consequences

- P3-02 gets fixed inputs: a version's columns map 1:1 to `HabitScheduleRule`; dates are ISO
  strings; weekdays ISO numbers. P3-03 only inserts versions and sets `effective_to`; the database
  refuses overlaps. P3-04 writes `habit_occurrences` and computes statuses; the database refuses
  impossible values for the type. P3-05 reads versions, records and pauses. P3-06 adds routes on
  `HabitRepository` and must check entitlements (PRD "maximum active habits") there.
- Every new habit-area table must carry `user_id` with `ON DELETE CASCADE` and be added to the
  `habits` export section (CI fails otherwise, ADR-0025).
- Hand-written CHECKs must be repeated by hand in any later migration that recreates these tables.
