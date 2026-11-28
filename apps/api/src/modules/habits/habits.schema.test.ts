import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HABIT_TYPE_VALUES } from '@habit/shared-types';
import {
  HABIT_DATE_MAX,
  HABIT_DATE_MIN,
  HABIT_LIMITS,
  HABIT_SCHEDULE_KINDS,
  HABIT_SCHEDULE_PERIODS,
  HABIT_TARGET_COMPARISONS,
  HABIT_TYPES,
  habitScheduleRuleSchema,
} from '@habit/shared-validation';
import { describe, expect, it } from 'vitest';
import {
  HabitScheduleKind,
  HabitSchedulePeriod,
  HabitTargetComparison,
  HabitType,
} from '../../generated/prisma/enums.js';
import { fromDbDate, scheduleColumns, scheduleRuleFromColumns, toDbDate } from './index.js';

// The habit CHECK/EXCLUDE constraints live in hand-written migration SQL (Prisma cannot express
// them), so this keeps the shared limits, enums and the database in step without a database.
const migrationsDir = resolve(import.meta.dirname, '../../../prisma/migrations');
const habitMigration = readdirSync(migrationsDir).find((d) => d.endsWith('_habit_domain_model'));
const sql = readFileSync(
  resolve(migrationsDir, habitMigration ?? 'missing', 'migration.sql'),
  'utf8',
);
const statements = sql.replace(/--.*$/gm, '');

describe('habit schema (P3-01)', () => {
  it('has the habit migration, and it is the newest one', () => {
    expect(habitMigration).toBeDefined();
    const all = readdirSync(migrationsDir)
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    expect(all.indexOf(habitMigration!)).toBeGreaterThan(
      all.indexOf('20261128090000_session_retention_indexes'),
    );
  });

  it('is additive only (no DROP, no data rewrite, no change to existing tables)', () => {
    expect(statements).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
    expect(statements).not.toMatch(
      /\b(DROP\s+(COLUMN|CONSTRAINT|TABLE|TYPE|INDEX|VALUE)|ALTER\s+COLUMN|RENAME)\b/i,
    );
    for (const altered of statements.matchAll(/ALTER TABLE "(\w+)"/g)) {
      expect(altered[1]).toMatch(/^habit/);
    }
  });

  it('database CHECK bounds match HABIT_LIMITS', () => {
    const L = HABIT_LIMITS;
    expect(statements).toContain(`char_length("name") BETWEEN 1 AND ${L.categoryNameMaxLength}`);
    expect(statements).toContain(`char_length("name") BETWEEN 1 AND ${L.nameMaxLength}`);
    expect(statements).toContain(
      `char_length("description") BETWEEN 1 AND ${L.descriptionMaxLength}`,
    );
    expect(statements).toContain(`char_length("unit") BETWEEN 1 AND ${L.unitMaxLength}`);
    expect(statements).toContain(`char_length("body") BETWEEN 1 AND ${L.noteMaxLength}`);
    expect(statements).toContain(`'^[a-z][a-z0-9-]{0,${L.colorTokenMaxLength - 1}}$'`);
    expect(statements).toContain(`'^[a-z][a-z0-9-]{0,${L.iconTokenMaxLength - 1}}$'`);
    expect(statements).toContain(
      `"preferred_time_minutes" BETWEEN 0 AND ${L.preferredTimeMaxMinutes}`,
    );
    expect(statements).toContain(`"grace_days" BETWEEN 0 AND ${L.graceDaysMax}`);
    expect(statements).toContain(
      `"interval_days" BETWEEN ${L.intervalDaysMin} AND ${L.intervalDaysMax}`,
    );
    expect(statements).toContain(`"times_per_period" BETWEEN 1 AND ${L.timesPerWeekMax}`);
    expect(statements).toContain(`"times_per_period" BETWEEN 1 AND ${L.timesPerMonthMax}`);
    expect(statements).toContain(`"target_value" BETWEEN 0 AND ${L.valueMax}`);
    expect(statements).toContain(`"value" BETWEEN 0 AND ${L.valueMax}`);
    expect(statements).toContain(`"target_value" BETWEEN 1 AND ${L.durationMaxSeconds}`);
    expect(statements).toContain(`"value" <= ${L.durationMaxSeconds}`);
    expect(statements).toContain(`DECIMAL(12,${L.valueDecimals})`);
    // The date window appears in every date CHECK and nowhere else differently.
    const dates = [...statements.matchAll(/DATE '(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
    expect(dates.length).toBeGreaterThanOrEqual(10);
    expect(new Set(dates)).toEqual(new Set([HABIT_DATE_MIN, HABIT_DATE_MAX]));
  });

  it('keeps schedule versions apart with an exclusion constraint (btree_gist created first)', () => {
    const ext = statements.indexOf('CREATE EXTENSION IF NOT EXISTS "btree_gist"');
    expect(ext).toBeGreaterThanOrEqual(0);
    expect(ext).toBeLessThan(statements.indexOf('EXCLUDE USING gist'));
    expect(statements).toMatch(
      /EXCLUDE USING gist \(\s*"habit_id" WITH =,\s*daterange\("effective_from", "effective_to", '\[\)'\) WITH &&\s*\)/,
    );
  });

  it('children reference habits by (id, user_id[, type]) and every table cascades from users', () => {
    for (const table of ['habit_schedule_versions', 'habit_occurrences']) {
      expect(statements).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_habit_id_user_id_habit_type_fkey" FOREIGN KEY ("habit_id", "user_id", "habit_type") REFERENCES "habits"("id", "user_id", "type") ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
    }
    for (const table of ['habit_notes', 'habit_pauses']) {
      expect(statements).toContain(
        `FOREIGN KEY ("habit_id", "user_id") REFERENCES "habits"("id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
      expect(statements).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_habit_id_user_id_fkey"`,
      );
    }
    expect(statements).toContain(
      `FOREIGN KEY ("category_id", "user_id") REFERENCES "habit_categories"("id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    for (const table of [
      'habit_categories',
      'habits',
      'habit_schedule_versions',
      'habit_occurrences',
      'habit_notes',
      'habit_pauses',
    ]) {
      expect(statements).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE`,
      );
    }
  });
});

describe('habit enums (P3-01)', () => {
  it('database, validation and contract lists agree', () => {
    const sorted = (v: Iterable<string>) => [...v].sort();
    expect(sorted(Object.values(HabitType))).toEqual(sorted(HABIT_TYPES));
    expect(sorted(HABIT_TYPE_VALUES)).toEqual(sorted(HABIT_TYPES));
    expect(sorted(Object.values(HabitScheduleKind))).toEqual(sorted(HABIT_SCHEDULE_KINDS));
    expect(sorted(Object.values(HabitSchedulePeriod))).toEqual(sorted(HABIT_SCHEDULE_PERIODS));
    expect(sorted(Object.values(HabitTargetComparison))).toEqual(sorted(HABIT_TARGET_COMPARISONS));
    // Every kind and type is named in the CHECK constraints' CASE branches.
    for (const kind of HABIT_SCHEDULE_KINDS) expect(statements).toContain(`WHEN '${kind}' THEN`);
    for (const type of HABIT_TYPES) expect(statements).toContain(`'${type}'`);
  });
});

describe('local dates and schedule columns (P3-01)', () => {
  it('converts local dates without any time-zone shift', () => {
    for (const day of ['2000-01-01', '2024-02-29', '2026-03-21', '2026-11-28', '2099-12-31']) {
      expect(fromDbDate(toDbDate(day))).toBe(day);
    }
    expect(() => toDbDate('2026-02-30')).toThrow(RangeError);
    expect(() => toDbDate('2026-11-28T00:00:00Z')).toThrow(RangeError);
  });

  it.each([
    { kind: 'daily' },
    { kind: 'weekdays', daysOfWeek: [1, 3, 5] },
    { kind: 'monthly_days', daysOfMonth: [-1, 1, 15] },
    { kind: 'interval', intervalDays: 3, anchorDate: '2026-11-28' },
    { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
  ])('round-trips %o through the columns, leaving other kinds’ columns empty', (input) => {
    const rule = habitScheduleRuleSchema.parse(input);
    const columns = scheduleColumns(rule);
    expect(scheduleRuleFromColumns(columns)).toEqual(rule);
    const used = Object.entries(columns).filter(
      ([k, v]) => k !== 'kind' && v !== null && !(Array.isArray(v) && v.length === 0),
    );
    expect(used.length).toBeLessThanOrEqual(2);
  });

  it('refuses a row that breaks its kind', () => {
    expect(() =>
      scheduleRuleFromColumns({ ...scheduleColumns({ kind: 'daily' }), kind: 'interval' }),
    ).toThrow(/does not match/);
  });
});
