# ADR-0029: Habit schedule engine — a pure package on local day numbers, with Solar Hijri months

- **Status:** Accepted (P3-02); open decision 1 taken (interim) in [ADR-0030](0030-schedule-versioning.md),
  open decision 5 in [ADR-0031](0031-occurrence-status-and-check-ins.md)
- **Date:** 2026-11-28

## Context

Backlog P3-02 (#32) asks for a deterministic function that turns a habit's schedule into
scheduled local dates: daily, selected weekdays, weekly frequency, monthly, custom intervals,
pauses, vacations and grace days (PRD §3.1 "Scheduling"), safe across time zones and DST, with
start/end dates and version boundaries. ADR-0028 fixed its inputs: local ISO dates, schedule
versions over `[effective_from, effective_to)` that never overlap, five schedule kinds
(`daily`, `weekdays`, `monthly_days` incl. `-1` = last day, `interval` from an `anchorDate`,
`times_per_period` week|month), pauses of one habit or vacations of all (`habit_id` null), grace
days per version. ADR-0024 made the calendar (Gregorian / Solar Hijri) and the first day of the
week (Saturday / Sunday / Monday) user preferences. The engine's consumers are P3-03 (versioning:
which version applied to a day), P3-04 (statuses: Completed / Missed / Due / Skipped / Paused /
Not scheduled), P3-05 (streaks and weekly/monthly consistency), P3-07 (weekly matrix) and,
later, offline use in the PWA (Phase 8). ARCHITECTURE §4 already required "a pure library with
exhaustive and property-based tests".

## Decision

### A workspace package, `@habit/habit-engine`

- New package `packages/habit-engine` (`@habit/habit-engine`, ESM, built to `dist/` like the other
  packages). It depends only on `@habit/shared-types` (the `HabitScheduleRule` contract) and
  `@habit/localization` (`WeekStart`, `CalendarSystem`) — both dependency-free — so it has **no
  third-party dependency**, no zod, no Node API and no I/O. Allowed edges (rules.js, ADR-0016):
  engine → shared-types, localization; api → engine (now: a contract test; P3-04 uses it at
  runtime); web → engine (allowed for the weekly matrix and offline mode; not yet a dependency of
  `apps/web`).
- A package rather than code inside `apps/api/src/modules/habits`: the web app may not import API
  code (ADR-0016), and the PWA will need the same answers offline. The package is meant to grow
  the other pure habit logic (P3-04 status rules, P3-05 streaks) next to the schedule.
- Nothing in it reads a clock or the environment. "Now" is always an argument.

### Local dates as integer day numbers

- Internally a local date is a **day number** (whole days since 1970-01-01), converted with
  Howard Hinnant's `days_from_civil` / `civil_from_days`. Weekdays, intervals and ranges are
  integer arithmetic; `Date` is never constructed from a local date, so DST, the server's zone and
  `Date` parsing quirks cannot shift a day. Inputs and outputs stay ISO `YYYY-MM-DD` strings
  (ADR-0028); unreal dates (`2026-02-29`, `2026-1-5`, Persian digits) are refused.
- The engine computes within the habit date window `2000-01-01..2099-12-31` (`ENGINE_DATE_MIN/MAX`,
  equal to `HABIT_DATE_MIN/MAX` — an API test keeps them, and the rule bounds `ENGINE_LIMITS`,
  equal to `@habit/shared-validation`). A range may span the whole window (36 525 days).

### API

| Export                                                                                                                                                                                                                          | Purpose                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `computeSchedule({ startsOn, endsOn, archivedOn?, versions, pauses, range })`                                                                                                                                                   | One `ScheduleDay` per date of the inclusive range + the `SchedulePeriod`s of `times_per_period` versions                            |
| `versionIdOn(versions, date)`                                                                                                                                                                                                   | The version in effect on a date (or `null`) — P3-03/P3-04 derive a record's version from it (ADR-0028: never stored)                |
| `periodContaining(date, 'week' \| 'month', { weekStart, calendar })`                                                                                                                                                            | The week / month containing a date (the matrix's columns, a month view)                                                             |
| `localDateAt(instant, timeZone)`, `isTimeZone`                                                                                                                                                                                  | "Today" (or any instant's local date) in an IANA zone                                                                               |
| Calendar helpers: `parseLocalDate`, `formatLocalDate`, `addDays`, `daysBetween`, `isoWeekday`, `gregorian*`, `solarHijri*`, `dayToSolarHijri`, `isSolarHijriLeapYear`, …                                                        | Shared, tested date arithmetic in both calendars                                                                                    |
| `ScheduleInputError` (`code`: `INVALID_DATE`, `DATE_OUT_OF_WINDOW`, `INVALID_RANGE`, `INVALID_HABIT_DATES`, `INVALID_VERSION`, `OVERLAPPING_VERSIONS`, `INVALID_RULE`, `INVALID_PAUSE`, `INVALID_TIME_ZONE`, `INVALID_INSTANT`) | Invalid input is refused, never repaired: the API validates first and the database refuses most of it, so this means a bug upstream |

A **version input** is the stored `HabitScheduleVersion` (`id`, `effectiveFrom`, `effectiveTo`,
`schedule`, `graceDays`) plus `weekStart` and `calendar` — the settings its periods are counted in
(see "Calendar settings per version" below).

### Day states

Each `ScheduleDay` has `state`, `versionId`, `graceDays`, `inactiveReason`, `pausedState` and
`period`. Precedence, first match wins:

1. `inactive` — `before_start` (before `startsOn`), `after_end` (after `endsOn`), `archived`
   (on/after `archivedOn`), `no_version` (no version covers the day, e.g. a gap between versions);
2. `paused` — a pause or vacation covers the day; `pausedState` keeps what the rule says
   (`due` / `flexible` / `off`), so P3-04 can choose whether a paused non-scheduled day shows as
   Paused or Not scheduled and streaks (P3-05) can skip paused days;
3. the rule: `due` (a fixed scheduled day), `flexible` (any day of an "N times per period" period
   may count), `off` (scheduled habit, not this day).

P3-04 maps these with the record and "today": `inactive`/`off` → Not scheduled, `paused` →
Paused, `due` → Completed/Skipped/Due/Missed by record and date, `flexible` → judged per period.
Pauses outside the habit's life change nothing; overlapping and adjacent pauses are merged;
`endsOn: null` pauses run until resumed. The caller passes the habit's pauses **and** the user's
vacations (`habit_id` null) in one list.

### Rules

- **daily** — every active day. **weekdays** — ISO weekdays (1 = Monday … 7 = Sunday), so the
  user's week start never changes which days are due.
- **monthly_days** — day numbers of the month in the version's calendar. **No clamping:** "31"
  happens only in 31-day months (Gregorian Jan/Mar/…; Solar Hijri months 1–6), "30" never in a
  29-day Esfand or in February; `-1` is the last day of every month (28/29 Feb; 29/30 Esfand).
  `[29, -1]` in a leap February is one due day. (Clamping "31" to the last day was rejected:
  users who want "end of month" pick it explicitly, and a silent move would surprise others.)
- **interval** — due when `(day − anchorDate) mod intervalDays = 0`, before and after the
  anchor (the shared validation's definition). The anchor is the rule's `anchorDate`, **not** the
  version start: a new version that keeps the anchor keeps the cadence (e.g. a target change),
  one with a new anchor restarts it. P3-03 should default `anchorDate` to the new version's
  `effectiveFrom` when the user (re)defines an interval, so "every N days from today" is the
  natural case. Month lengths, leap days and DST are irrelevant (pure day counts).
- **times_per_period** — every active day is `flexible` and points at its `SchedulePeriod`:
  `{ versionId, kind, start, end, totalDays, coveredDays, pausedDays, activeDays, timesPerPeriod,
required, partial }`. Periods are the user's **week** (7 days from `weekStart`) or **month**
  (Gregorian or Solar Hijri, 28–31 / 29–31 days). One period exists per (version, calendar period):
  when a version starts or ends mid-period, each version's part is judged on its own days.
  - **Proration:** `required = min(activeDays, ceil(timesPerPeriod × activeDays / totalDays))`,
    where `activeDays` = days of the period on which this version applies, the habit is active and
    not paused. A full period requires `timesPerPeriod` (capped at the length of a short month:
    31×/month in February requires 28/29); a habit that starts on a Thursday with 3×/week (Monday
    weeks) needs 2 that week; a fully paused week needs 0. Alternatives — no proration (impossible
    weeks after a mid-week start or pause), floor (a 1-day remainder would need 0), "skip partial
    periods" (pausing would erase targets) — were rejected; the formula is interim (owner).
  - Periods are always computed over the **whole calendar period**, also when the requested range
    covers only part of it, so the answer never depends on the range (tested).

### Calendar settings per version (week start, calendar)

- Week periods depend on the week start, month periods and "day N of the month" on the calendar.
  Both are user preferences that can change (ADR-0024). Re-reading old versions with today's
  preference would re-bucket past weeks and move past monthly due days — a silent rewrite of
  history (PRD "Historical integrity").
- So the engine takes `weekStart` and `calendar` **per version** and never defaults them.
  **Recommended for P3-03:** snapshot the user's `week_start` and `calendar` onto each new
  `habit_schedule_versions` row (two additive NOT NULL columns with the user's current values as
  backfill), so changing a preference affects only versions created afterwards. Until then
  (P3-03/P3-04 decide), callers pass the user's current preferences.
- **Solar Hijri month periods are required:** for a Persian user, "the 1st of the month" and "10
  times a month" mean Farvardin, Ordibehesht, …; the date pickers show those months. Gregorian
  users get Gregorian months. Week periods are calendar-independent.

### Solar Hijri conversion: in-repo, tested against `Intl`

- `Intl` (`calendar: 'persian'`) can only format, needs a `Date` per day, is slower and follows
  whatever ICU version the runtime ships — the server and each browser could disagree. The engine
  therefore implements the calendar itself with **Kazimierz Borkowski's leap-cycle ("breaks")
  algorithm** (Earth, Moon and Planets 74, 1996; the algorithm `jalaali-js` uses), valid for years
  1..3177 AP and following the official astronomical calendar.
- Tests: known dates (Nowruz 1379, 1396, 1399–1405, 1408; 30 Esfand 1399/1403/1408; 29 Esfand
  1402/1404; 22 Bahman 1357; 2026-11-28 = 7 Azar 1405), the leap years 1370..1480, round trips,
  every year's length, and **every day of 2000–2099 compared with Node 24's `Intl` persian
  calendar (ICU 78.3): identical**. ICU diverges from 1503 AP (2124), outside the window, where it
  applies its own leap rule; a test documents it. No dependency added (`jalaali-js` and
  `Temporal` were considered: the former is one small function we now own and test; `Temporal` is
  not available in Node 24 without a flag/polyfill).

### "Today" from an instant and a zone

- `localDateAt(instant, timeZone)` formats the instant with `Intl.DateTimeFormat` (Gregorian, Latin
  digits) in the user's IANA zone — the only place the engine touches time zones. It accepts a
  `Date`, epoch milliseconds or an ISO string **with** an offset (zone-less strings are refused:
  they would be read in the server's zone). Formatters are cached (≤ 64 zones). Tested for
  Asia/Tehran (today UTC+03:30; UTC+04:30 summers until 2022), America/New_York on both DST
  transition days, America/Los_Angeles, Sao_Paulo, St_Johns (−03:30), Kiritimati (+14), Pago_Pago
  (−11), Kathmandu (+05:45), Samoa's skipped 2011-12-30, and every zone `Intl` lists.
- Stored local dates never move when the user travels or changes zone: only "which day is today"
  changes (P3-04 validates a check-in's date against it, ADR-0028).

### Archive and grace days

- `archivedOn` is the first local date no longer tracked (the archive instant's local date in the
  user's zone): the archive day itself is not scheduled. The model keeps no archive history, so a
  restored habit's archived gap is scheduled again (owner decision; an archive-history table
  would fix it).
- `graceDays` is passed through on every active day; what grace days forgive is P3-05's.

### Determinism, limits, performance

- Same input → same output (deep-equal), regardless of the order of versions and pauses; the
  input is never mutated; a sub-range's answer equals the slice of a larger range's answer.
- Cost is linear in the range (plus the ≤ 31 days of each touched period); versions and pauses
  are found by binary search. Measured on Node 24 (this sandbox): two years with 25 versions of
  every kind and 200 pauses ≈ 2 ms, the whole 100-year window ≈ 27 ms, one week ≈ 5 µs. Tests
  assert < 50 ms for two years and < 1 s for the window.

### Tests

- Table-driven unit tests per rule, life boundary, version boundary, pause, calendar, week start
  and error code; seeded **property tests** (400 random habits each: versions in any order with
  gaps, every rule, both calendars, all week starts, overlapping/open pauses, end and archive
  dates) checking each day against a naive re-implementation, period counts by brute force, range
  independence, order independence and full-period targets.
- No fast-check: a 60-line seeded generator (`src/test-support/random.ts`) gives reproducible
  cases (failures name their seed) without a dependency.
- The repository has no coverage tooling. Measured once outside the repository with
  `@vitest/coverage-v8` 5.1.1: **100 % statements, branches, functions and lines** of the engine
  sources. Adding coverage to CI is an owner decision (new dev dependency).

## Alternatives considered

- **Engine inside the API habits module** — simplest today, but the web app (weekly matrix, PWA)
  could not reuse it (ADR-0016) and would grow a second implementation.
- **Materialised occurrence rows** — rejected in ADR-0028; the engine computes on demand instead.
- **`Date` at UTC midnight for local dates** — works, but invites zone bugs (`new Date('2026-03-08')`
  vs `new Date(2026, 2, 8)`) and is slower than integers.
- **`Intl` persian calendar at runtime** — see above (formatting-only, ICU-dependent, slow).
- **Gregorian months for everyone** — wrong for Persian users' "monthly" habits.
- **Week start / calendar read from the user at computation time only** — rewrites history when the
  preference changes; kept as the interim caller behaviour, with the snapshot recommended.
- **fast-check** for property tests — the issue suggests it; the in-repo generator covers the same
  properties without a dependency (revisit if shrinking becomes valuable).

## Open decisions (interim choices, reversible; for the owner)

1. **Snapshot week start and calendar on schedule versions** (recommended, P3-03) vs using the
   current preference (history of week/month periods follows later preference changes).
2. **Proration** of "N times per period" in partial periods: `ceil(N × activeDays / totalDays)`,
   capped by active days.
3. **Monthly days without clamping** (31 only in 31-day months; `-1` for the last day).
4. **Archive day** is not tracked; restoring a habit reschedules the archived gap.
5. **Paused non-scheduled days**: the engine reports `paused` with `pausedState: 'off'`; P3-04
   decides whether the matrix shows them as Paused or Not scheduled (proposal: Paused).
6. **Coverage tooling** in CI (`@vitest/coverage-v8`), not added.

## Consequences

- P3-03 creates versions through `versionIdOn`-compatible ranges (the database already refuses
  overlaps) and decides the snapshot columns; P3-04 maps `ScheduleDay`s and records to statuses
  and uses `localDateAt` for "today"; P3-05 reads days, periods and grace days; P3-07 uses
  `periodContaining` for the visible week.
- Any change to the engine's bounds must change `@habit/shared-validation` and the database CHECKs
  together (the API contract test fails otherwise).
- Habit logic that is pure belongs in this package; I/O stays in the API module.

## Addendum (P3-03, ADR-0030)

- Open decision 1 is taken as recommended (interim, reversible): every schedule version stores
  the `week_start` and `calendar` it was written with; existing versions were backfilled from
  their owner's preferences. A stored `HabitScheduleVersion` is now a `ScheduleVersionInput` as
  it is — callers no longer pass the current preferences.
- A new `interval` rule without `anchorDate` is anchored on the version's effective date.
- `apps/api` uses the engine at runtime (`localDateAt` for "today", `versionIdOn` and
  `computeSchedule` to check planned version sets), so it is a regular dependency now.

## Addendum (P3-04, ADR-0031)

- The package now also holds the status rules: `computeStatuses` (Completed / Missed / Due /
  Skipped / Paused / Not scheduled, progress, frequency period status), `judgeValue`,
  `statusRecordRange` and the check-in rules `checkInRefusal`; new error code `INVALID_RECORD`.
- Open decision 5 is taken (interim): a paused day is **Paused** whatever the rule says
  (`pausedState` keeps it).
