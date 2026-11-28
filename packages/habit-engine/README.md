# @habit/habit-engine

Pure, deterministic habit logic (ADR-0029, ADR-0031): the **schedule engine** (backlog P3-02) —
which local dates a habit is due on, from its start/end/archive dates, schedule versions,
pauses/vacations and a date range — and the **status rules** (P3-04): what each day is and
whether a check-in may be written. No I/O, no clock, no third-party dependency (only the types
and calendar settings of `@habit/shared-types` and `@habit/localization`). Consumed through
`dist/` — run `pnpm build:packages` first.

```ts
import { computeSchedule, localDateAt, periodContaining } from '@habit/habit-engine';

const today = localDateAt(new Date(), 'Asia/Tehran'); // '2026-11-28'
const week = periodContaining(today, 'week', { weekStart: 'saturday', calendar: 'solar_hijri' });
const { days, periods } = computeSchedule({
  startsOn: '2026-01-01',
  endsOn: null,
  archivedOn: null,
  versions: [
    {
      id: 'v1',
      effectiveFrom: '2026-01-01',
      effectiveTo: null, // exclusive; null = current
      schedule: { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
      graceDays: 0,
      weekStart: 'saturday',
      calendar: 'solar_hijri',
    },
  ],
  pauses: [{ startsOn: '2026-12-01', endsOn: '2026-12-02' }], // habit pauses + vacations
  range: { from: week.start, to: week.end },
});
// days[i].state: 'due' | 'flexible' | 'off' | 'paused' | 'inactive'
// periods[days[i].period].required: how many days of that week must count
```

- **Dates** are ISO `YYYY-MM-DD` local dates; internally integer day numbers (no `Date`, so DST
  and server zones cannot move a day). Window `2000-01-01..2099-12-31`.
- **Rules:** `daily`; `weekdays` (ISO 1 = Monday … 7 = Sunday); `monthly_days` (1..31 without
  clamping, `-1` = last day; in the version's calendar); `interval` (every N days from
  `anchorDate`, both directions); `times_per_period` (week by `weekStart` or Gregorian/Solar
  Hijri month; target prorated to active days in partial periods).
- **Solar Hijri** conversion (Borkowski's algorithm) is tested against `Intl`'s `persian`
  calendar for every day of the window.
- **Calendar settings per version:** `weekStart` and `calendar` come with each version — the
  API stores them on every schedule version (P3-03, ADR-0030), so a stored version is an engine
  version as it is and a later preference change never re-buckets history.
- **Errors:** `ScheduleInputError` with a `code`; input is never repaired.
- Tests: table-driven + seeded property tests (`src/test-support/random.ts`).

## Statuses (P3-04, ADR-0031)

```ts
import { checkInRefusal, computeStatuses, statusRecordRange } from '@habit/habit-engine';

const records = loadRecords(
  statusRecordRange({ startsOn, endsOn, archivedOn, versions, pauses, range }),
);
const { days, periods } = computeStatuses({
  habitType: 'numeric',
  startsOn,
  endsOn,
  archivedOn,
  pauses,
  range,
  versions, // schedule versions with their `target` ({ comparison: 'at_least' | 'at_most', value })
  records, // [{ localDate, value, skipped }]
  today: localDateAt(new Date(), timeZone),
});
// days[i].status: 'completed' | 'missed' | 'due' | 'skipped' | 'paused' | 'not_scheduled'
// days[i].progress: { value, target, met, partial, percent }; days[i].openUntil: last Due day
// periods[days[i].period]: frequency periods with target (after skips), completed, status
checkInRefusal('skip', date, today, scheduleDay); // null | 'DATE_IN_FUTURE' | 'DATE_NOT_TRACKED' | 'SKIP_NOT_ALLOWED'
```

- Not scheduled = inactive or `off` days; Paused = any paused day; a scheduled day is Completed
  when the value meets the version's target, Skipped when excused, Missed once
  `today > date + graceDays` (or at once when an "at most" limit is exceeded), else Due.
- Frequency habits are judged per period; skips re-prorate the period's target.
- Tests: table-driven per type and status, seeded property tests against a naive reference.
