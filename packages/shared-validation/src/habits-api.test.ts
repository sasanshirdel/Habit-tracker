import { describe, expect, it } from 'vitest';
import {
  HABIT_COLOR_TOKENS,
  HABIT_ORDER_MAX_ITEMS,
  habitCategoryCreateSchema,
  habitCategoryReorderSchema,
  habitCategoryUpdateSchema,
  habitColorTokenSchema,
  habitCreateSchema,
  habitExpectedVersionQuerySchema,
  habitListQuerySchema,
  habitReorderSchema,
  habitUpdateSchema,
} from './index.js';

// Request rules of the habits API (P3-06, ADR-0032).
const ID = '0195f0b4-0000-7000-8000-000000000001';
const ID2 = '0195f0b4-0000-7000-8000-000000000002';
const issuesOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.success ? [] : result.error!.issues.map((i) => i.path.join('.'));

describe('habitCreateSchema', () => {
  it('fills defaults: no target, unit, category, icon, colour, time, end; grace 0; start left to the server', () => {
    expect(
      habitCreateSchema.parse({ name: ' Read ', type: 'binary', schedule: { kind: 'daily' } }),
    ).toEqual({
      name: 'Read',
      description: null,
      type: 'binary',
      unit: null,
      schedule: { kind: 'daily' },
      target: null,
      graceDays: 0,
      categoryId: null,
      icon: null,
      color: null,
      preferredTime: null,
      endsOn: null,
    });
  });

  it('accepts each of the six types with its rules', () => {
    const cases = [
      { type: 'binary', schedule: { kind: 'weekdays', daysOfWeek: [1, 3] } },
      {
        type: 'numeric',
        unit: 'pages',
        schedule: { kind: 'daily' },
        target: { comparison: 'at_least', value: 10 },
      },
      {
        type: 'duration',
        schedule: { kind: 'interval', intervalDays: 2 },
        target: { comparison: 'at_least', value: 1800 },
      },
      {
        type: 'frequency',
        schedule: { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
      },
      {
        type: 'negative',
        schedule: { kind: 'daily' },
        target: { comparison: 'at_most', value: 0 },
      },
      {
        type: 'custom',
        unit: 'min',
        schedule: { kind: 'monthly_days', daysOfMonth: [1, -1] },
        target: { comparison: 'at_most', value: 30 },
      },
    ];
    for (const input of cases) {
      expect(habitCreateSchema.safeParse({ name: 'H', ...input }).success, input.type).toBe(true);
    }
  });

  it('refuses rules, units and dates that do not fit', () => {
    expect(
      issuesOf(
        habitCreateSchema.safeParse({ name: 'H', type: 'numeric', schedule: { kind: 'daily' } }),
      ),
    ).toEqual(['target']);
    expect(
      issuesOf(
        habitCreateSchema.safeParse({
          name: 'H',
          type: 'binary',
          unit: 'x',
          schedule: { kind: 'times_per_period', period: 'week', timesPerPeriod: 2 },
        }),
      ),
    ).toEqual(['unit', 'schedule.kind']);
    expect(
      issuesOf(
        habitCreateSchema.safeParse({
          name: 'H',
          type: 'custom',
          schedule: { kind: 'daily' },
          target: { comparison: 'at_most', value: 1 },
        }),
      ),
    ).toEqual(['unit']);
    expect(
      issuesOf(
        habitCreateSchema.safeParse({
          name: 'H',
          type: 'binary',
          schedule: { kind: 'daily' },
          startsOn: '2026-05-02',
          endsOn: '2026-05-01',
        }),
      ),
    ).toEqual(['endsOn']);
  });

  it('only palette colours; goalId only null; no unknown fields', () => {
    const base = { name: 'H', type: 'binary', schedule: { kind: 'daily' } };
    for (const color of HABIT_COLOR_TOKENS) {
      expect(habitColorTokenSchema.safeParse(color).success).toBe(true);
      expect(habitCreateSchema.safeParse({ ...base, color }).success).toBe(true);
    }
    expect(habitCreateSchema.safeParse({ ...base, color: 'chartreuse' }).success).toBe(false);
    expect(habitCreateSchema.safeParse({ ...base, color: '#ff0000' }).success).toBe(false);
    expect(habitCreateSchema.safeParse({ ...base, goalId: null }).success).toBe(true);
    expect(habitCreateSchema.safeParse({ ...base, goalId: ID }).success).toBe(false);
    expect(habitCreateSchema.safeParse({ ...base, position: 3 }).success).toBe(false);
  });
});

describe('habitUpdateSchema', () => {
  it('a non-empty subset; null clears; expectedVersion alone is not an edit', () => {
    expect(habitUpdateSchema.parse({ description: null, expectedVersion: 2 })).toEqual({
      description: null,
      expectedVersion: 2,
    });
    expect(habitUpdateSchema.safeParse({}).success).toBe(false);
    expect(habitUpdateSchema.safeParse({ expectedVersion: 2 }).success).toBe(false);
    expect(habitUpdateSchema.safeParse({ goalId: null }).success).toBe(false);
    expect(habitUpdateSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('never changes type or rules here (schedule changes are versioned)', () => {
    for (const key of ['type', 'schedule', 'target', 'graceDays', 'position', 'archivedAt']) {
      expect(habitUpdateSchema.safeParse({ name: 'x', [key]: null }).success, key).toBe(false);
    }
  });

  it('checks start/end order when both are sent', () => {
    expect(
      issuesOf(habitUpdateSchema.safeParse({ startsOn: '2026-05-02', endsOn: '2026-05-01' })),
    ).toEqual(['endsOn']);
    expect(habitUpdateSchema.safeParse({ startsOn: '2026-05-02', endsOn: null }).success).toBe(
      true,
    );
  });
});

describe('list, reorder and version queries', () => {
  it('list defaults to active habits, 20 per page', () => {
    expect(habitListQuerySchema.parse({})).toEqual({ limit: 20, status: 'active' });
    expect(
      habitListQuerySchema.parse({ status: 'deleted', categoryId: 'none', limit: '5' }),
    ).toEqual({
      status: 'deleted',
      categoryId: 'none',
      limit: 5,
    });
    expect(habitListQuerySchema.safeParse({ status: 'all' }).success).toBe(false);
    expect(habitListQuerySchema.safeParse({ categoryId: 'x' }).success).toBe(false);
    expect(habitListQuerySchema.safeParse({ sort: 'name' }).success).toBe(false);
  });

  it('reorders list each id once, at least one, at most the cap', () => {
    expect(habitReorderSchema.safeParse({ habitIds: [ID, ID2] }).success).toBe(true);
    expect(habitReorderSchema.safeParse({ habitIds: [ID, ID] }).success).toBe(false);
    expect(habitReorderSchema.safeParse({ habitIds: [ID, ID.toUpperCase()] }).success).toBe(false);
    expect(habitReorderSchema.safeParse({ habitIds: [] }).success).toBe(false);
    expect(habitCategoryReorderSchema.safeParse({ categoryIds: [ID] }).success).toBe(true);
    const tooMany = Array.from(
      { length: HABIT_ORDER_MAX_ITEMS + 1 },
      (_, i) => `0195f0b4-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(habitReorderSchema.safeParse({ habitIds: tooMany }).success).toBe(false);
  });

  it('expectedVersion arrives as a query string', () => {
    expect(habitExpectedVersionQuerySchema.parse({ expectedVersion: '3' })).toEqual({
      expectedVersion: 3,
    });
    expect(habitExpectedVersionQuerySchema.parse({})).toEqual({});
    expect(habitExpectedVersionQuerySchema.safeParse({ expectedVersion: '0' }).success).toBe(false);
  });
});

describe('category schemas', () => {
  it('create normalises the name; update needs a change', () => {
    expect(habitCategoryCreateSchema.parse({ name: '  Health ' })).toEqual({
      name: 'Health',
      color: null,
      icon: null,
    });
    expect(habitCategoryCreateSchema.safeParse({ name: 'x'.repeat(51) }).success).toBe(false);
    expect(habitCategoryUpdateSchema.safeParse({ color: 'teal' }).success).toBe(true);
    expect(habitCategoryUpdateSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(habitCategoryUpdateSchema.safeParse({ color: 'neon' }).success).toBe(false);
  });
});
