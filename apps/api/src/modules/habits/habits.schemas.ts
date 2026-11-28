import { z } from 'zod';
import { HABIT_DELETED_RESTORE_DAYS, HABIT_TYPE_VALUES } from '@habit/shared-types';
import {
  HABIT_COLOR_TOKENS,
  HABIT_SCHEDULE_PERIODS,
  HABIT_TARGET_COMPARISONS,
  habitCategoryCreateSchema,
  habitCategoryReorderSchema,
  habitCategoryUpdateSchema,
  habitCreateSchema,
  habitExpectedVersionQuerySchema,
  habitListQuerySchema,
  habitReorderSchema,
  habitScheduleChangeSchema,
  habitUpdateSchema,
  paginationQuerySchema,
} from '@habit/shared-validation';
import { component, errorEnvelopeWith, paginatedSchema } from '../../openapi/index.js';

/**
 * Schemas of the habits and categories routes (backlog P3-06, ADR-0032). Request rules come from
 * `@habit/shared-validation` (the web forms reuse them); response schemas mirror
 * `@habit/shared-types` (asserted in `habits-api.test.ts`).
 */

const PALETTE = `One of: ${HABIT_COLOR_TOKENS.join(', ')}.`;

export const categoryIdParamSchema = z
  .uuid()
  .meta({ description: 'Id of one of your categories.' });

export const habitCreateBodySchema = habitCreateSchema.meta({
  description:
    'A new habit. `type` is fixed for life. `schedule` + `target` + `graceDays` become the first ' +
    'schedule version, effective from `startsOn` (default: your today in your profile time ' +
    'zone); an interval schedule without `anchorDate` counts from `startsOn`. Targets: none for ' +
    'binary and frequency, "at least" for numeric and duration (seconds), "at most" lapses for ' +
    `negative, either for custom; \`unit\` required for custom, optional for numeric and negative. Colour: ${PALETTE} ` +
    '`goalId` is reserved for goals (Phase 4) and accepts only `null`.',
});

export const habitUpdateBodySchema = habitUpdateSchema.meta({
  description:
    'Any non-empty subset of the metadata; `null` clears an optional field. Schedule, target and ' +
    'grace days change through `POST /habits/{habitId}/schedule-changes` (versioned, history ' +
    'kept). Moving `startsOn` earlier extends the first schedule version back; moving it later, ' +
    'or `endsOn` earlier, is refused with 409 `HABIT_DATES_CONFLICT` if recorded days would fall ' +
    'outside the dates. `expectedVersion` (optional): the habit `version` you last saw; the edit ' +
    'is refused with 409 `VERSION_CONFLICT` if the habit changed meanwhile — unless it changes ' +
    `nothing (then the habit is returned as is). Colour: ${PALETTE}`,
});

export const habitListQueryParamsSchema = habitListQuerySchema;

export const habitReorderBodySchema = habitReorderSchema.meta({
  description:
    'Every active habit id exactly once, in the new order (first = top). Archived and deleted ' +
    'habits are not part of the order.',
});

export const habitScheduleChangeBodySchema = habitScheduleChangeSchema.meta({
  description:
    'New schedule rules (ADR-0030). They take effect on `effectiveFrom` (default: your today, or ' +
    'the habit’s first day if later); past days keep the rules they were judged by. A date before ' +
    'your today is a historical correction and needs a `reason`. `expectedHabitVersion` ' +
    '(optional) makes the change conditional on the habit `version` you last saw.',
});

export const expectedVersionQuerySchema = habitExpectedVersionQuerySchema;

export const categoryListQuerySchema = z.strictObject(paginationQuerySchema.shape);

export const categoryCreateBodySchema = habitCategoryCreateSchema.meta({
  description: `A new category; names are unique per user, case-insensitively. Colour: ${PALETTE}`,
});

export const categoryUpdateBodySchema = habitCategoryUpdateSchema.meta({
  description:
    'Rename and/or recolour: a non-empty subset; `expectedVersion` as for habits (no conflict ' +
    'when nothing changes).',
});

export const categoryReorderBodySchema = habitCategoryReorderSchema.meta({
  description: 'Every category id exactly once, in the new order (first = top).',
});

// ── Responses ───────────────────────────────────────────────────────────────────────────────────

const localDate = (description: string) => z.iso.date().meta({ description });
const instant = (description: string) => z.iso.datetime().meta({ description });

const scheduleRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('daily') }),
  z.strictObject({
    kind: z.literal('weekdays'),
    daysOfWeek: z.array(z.int()).meta({ description: 'ISO weekdays, 1 = Monday … 7 = Sunday.' }),
  }),
  z.strictObject({
    kind: z.literal('monthly_days'),
    daysOfMonth: z.array(z.int()).meta({ description: '1..31; -1 = last day of the month.' }),
  }),
  z.strictObject({
    kind: z.literal('interval'),
    intervalDays: z.int(),
    anchorDate: localDate('A day the interval falls on.'),
  }),
  z.strictObject({
    kind: z.literal('times_per_period'),
    period: z.enum(HABIT_SCHEDULE_PERIODS),
    timesPerPeriod: z.int(),
  }),
]);

const targetSchema = z.strictObject({
  comparison: z.enum(HABIT_TARGET_COMPARISONS),
  value: z.number(),
});

const versionShape = {
  id: z.uuid(),
  effectiveFrom: localDate('First local date the version applies to.'),
  effectiveTo: localDate('Exclusive end; `null` while current.').nullable(),
  schedule: scheduleRuleSchema,
  target: targetSchema.nullable(),
  graceDays: z.int().min(0),
  weekStart: z.enum(['saturday', 'sunday', 'monday']),
  calendar: z.enum(['gregorian', 'solar_hijri']),
};

export const habitScheduleVersionSchema = component(
  z.strictObject({ ...versionShape, createdAt: instant('When the version was written.') }),
  {
    id: 'HabitScheduleVersion',
    description:
      'One version of a habit’s rules, in effect for local dates [effectiveFrom, effectiveTo); weeks and months are counted in its own `weekStart`/`calendar` (ADR-0030).',
  },
);

export const habitSchema = component(
  z.strictObject({
    id: z.uuid(),
    categoryId: z.uuid().nullable(),
    type: z.enum(HABIT_TYPE_VALUES),
    name: z.string(),
    description: z.string().nullable(),
    unit: z.string().nullable(),
    icon: z.string().nullable(),
    color: z.string().nullable().meta({ description: 'Palette token.' }),
    startsOn: localDate('First local date (inclusive).'),
    endsOn: localDate('Last local date (inclusive); `null` = open-ended.').nullable(),
    preferredTime: z.string().nullable().meta({ description: 'Local `HH:MM`; `null` = any time.' }),
    position: z.int().min(0).meta({ description: 'Your sort order (ascending, ties by id).' }),
    version: z.int().min(1).meta({
      description: 'Send as `expectedVersion` to write conditionally.',
    }),
    archivedAt: instant('When archived; `null` = active.').nullable(),
    deletedAt: instant(
      `When deleted; restorable for ${HABIT_DELETED_RESTORE_DAYS} days. \`null\` = not deleted.`,
    ).nullable(),
    createdAt: instant('Created (UTC).'),
    updatedAt: instant('Last changed (UTC).'),
  }),
  { id: 'Habit', description: 'A habit (its rules over time are its schedule versions).' },
);

export const habitDetailSchema = component(
  z.strictObject({
    habit: habitSchema,
    scheduleVersions: z.array(habitScheduleVersionSchema).meta({ description: 'Oldest first.' }),
    currentVersionId: z.uuid().nullable().meta({
      description:
        'The version in effect on your today; before the habit starts its first, after the last version ends the last.',
    }),
  }),
  { id: 'HabitDetail', description: 'A habit with all its schedule versions.' },
);

export const habitListSchema = component(paginatedSchema(habitDetailSchema), {
  id: 'HabitList',
  description: 'A page of your habits in your sort order.',
});

export const habitOrderSchema = component(z.strictObject({ data: z.array(habitSchema) }), {
  id: 'HabitOrder',
  description: 'Your active habits in their new order.',
});

const snapshotSchema = z.strictObject(versionShape);

export const habitScheduleChangeRecordSchema = component(
  z.strictObject({
    id: z.uuid(),
    habitId: z.uuid(),
    versionId: z.uuid(),
    operation: z.enum(['create', 'split', 'replace']),
    effectiveFrom: localDate('First day the change applies to.'),
    localToday: localDate('Your local date when the change was made.'),
    isCorrection: z.boolean(),
    reason: z.string().nullable(),
    affectedRecordedDays: z.int().min(0),
    before: z.array(snapshotSchema).nullable(),
    after: z.array(snapshotSchema),
    createdAt: instant('When the change was made.'),
  }),
  { id: 'HabitScheduleChange', description: 'One entry of the append-only schedule audit trail.' },
);

export const habitScheduleChangeOutcomeSchema = component(
  z.strictObject({
    outcome: z.enum(['unchanged', 'split', 'replace']),
    detail: habitDetailSchema,
    change: habitScheduleChangeRecordSchema.nullable(),
  }),
  {
    id: 'HabitScheduleChangeOutcome',
    description:
      '`unchanged` (identical rules, nothing written), `split` (a new version from the effective date) or `replace` (the version starting on that date rewritten).',
  },
);

export const habitCategorySchema = component(
  z.strictObject({
    id: z.uuid(),
    name: z.string(),
    color: z.string().nullable(),
    icon: z.string().nullable(),
    position: z.int().min(0),
    version: z.int().min(1),
    createdAt: instant('Created (UTC).'),
    updatedAt: instant('Last changed (UTC).'),
  }),
  { id: 'HabitCategory', description: 'One of your habit categories.' },
);

export const habitCategoryListSchema = component(paginatedSchema(habitCategorySchema), {
  id: 'HabitCategoryList',
  description: 'A page of your categories in your sort order.',
});

export const habitCategoryOrderSchema = component(
  z.strictObject({ data: z.array(habitCategorySchema) }),
  { id: 'HabitCategoryOrder', description: 'Your categories in their new order.' },
);

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

export const habitConflictErrorSchema = component(
  errorEnvelopeWith(
    z.enum(['VERSION_CONFLICT', 'ORDER_MISMATCH', 'HABIT_DATES_CONFLICT']),
    z
      .strictObject({
        currentVersion: z.int().min(1).optional(),
        expected: z.int().min(0).optional(),
        received: z.int().min(0).optional(),
        reason: z.enum(['records_outside_dates', 'schedule_versions']).optional(),
        recordedDays: z.int().min(0).optional(),
      })
      .optional(),
  ),
  {
    id: 'HabitConflictError',
    description:
      '409: `VERSION_CONFLICT` (the habit is no longer `expectedVersion`; `details.currentVersion`), `ORDER_MISMATCH` (the order does not list exactly your active habits; read them again) or `HABIT_DATES_CONFLICT` (recorded days or a later schedule version would fall outside the new dates; `details.reason`).',
  },
);

export const habitScheduleConflictErrorSchema = component(
  errorEnvelopeWith(z.enum(['VERSION_CONFLICT', 'HABIT_DATES_CONFLICT']), z.unknown().optional()),
  {
    id: 'HabitScheduleConflictError',
    description:
      '409: `VERSION_CONFLICT` (the habit changed since `expectedHabitVersion`, or a concurrent change won) or `HABIT_DATES_CONFLICT` (recorded days would be left without rules).',
  },
);

export const habitCategoryNotFoundErrorSchema = component(
  errorEnvelopeWith(z.literal('NOT_FOUND'), z.unknown().optional()),
  {
    id: 'HabitCategoryNotFoundError',
    description:
      '404 `NOT_FOUND`: no such category of yours — identical for one that does not exist or belongs to someone else.',
  },
);

export const habitOrCategoryNotFoundErrorSchema = component(
  errorEnvelopeWith(z.literal('NOT_FOUND'), z.unknown().optional()),
  {
    id: 'HabitOrCategoryNotFoundError',
    description:
      '404 `NOT_FOUND`: the habit, or the `categoryId` given, is not one of yours (missing, deleted or someone else’s look the same).',
  },
);

export const categoryConflictErrorSchema = component(
  errorEnvelopeWith(
    z.enum(['VERSION_CONFLICT', 'CATEGORY_NOT_EMPTY', 'CATEGORY_NAME_TAKEN', 'ORDER_MISMATCH']),
    z
      .strictObject({
        currentVersion: z.int().min(1).optional(),
        habitCount: z.int().min(1).optional(),
        expected: z.int().min(0).optional(),
        received: z.int().min(0).optional(),
      })
      .optional(),
  ),
  {
    id: 'HabitCategoryConflictError',
    description:
      '409: `VERSION_CONFLICT` (`details.currentVersion`), `CATEGORY_NOT_EMPTY` (active or archived habits still use it; `details.habitCount`), `CATEGORY_NAME_TAKEN` (you have a category with that name) or `ORDER_MISMATCH`.',
  },
);
