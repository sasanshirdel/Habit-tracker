import { z } from 'zod';
import { localDateSchema } from './local-date.js';

/**
 * Habit domain input rules (backlog P3-01, ADR-0028). These are the domain invariants every habit
 * write must satisfy; the database enforces the same rules with CHECK/EXCLUDE constraints
 * (migration `…_habit_domain_model`, kept in step with {@link HABIT_LIMITS} by an API unit test).
 * P3-03 (schedule versioning), P3-04 (check-ins) and P3-06 (habits API) build their request
 * bodies from these pieces; the web forms reuse them for immediate feedback only.
 *
 * Dates are ISO `YYYY-MM-DD` local calendar dates (Gregorian). Solar Hijri is a display concern
 * (ADR-0024): clients convert at the edge, the API and database never see Hijri dates.
 */

/** The six habit types (PRD §3.1). A habit's type never changes (ADR-0028). */
export const HABIT_TYPES = [
  'binary',
  'numeric',
  'duration',
  'frequency',
  'negative',
  'custom',
] as const;
export type HabitTypeValue = (typeof HABIT_TYPES)[number];

/** How a schedule picks due days (P3-02 computes them). */
export const HABIT_SCHEDULE_KINDS = [
  'daily',
  'weekdays',
  'monthly_days',
  'interval',
  'times_per_period',
] as const;
export const HABIT_SCHEDULE_PERIODS = ['week', 'month'] as const;
export const HABIT_TARGET_COMPARISONS = ['at_least', 'at_most'] as const;

/** Bounds shared by validation and the database CHECK constraints. */
export const HABIT_LIMITS = {
  nameMaxLength: 100,
  descriptionMaxLength: 2000,
  unitMaxLength: 24,
  categoryNameMaxLength: 50,
  noteMaxLength: 5000,
  colorTokenMaxLength: 32,
  iconTokenMaxLength: 64,
  /** Largest recorded value or target (amounts, lapses, seconds are further bounded below). */
  valueMax: 1_000_000,
  /** Decimal places of recorded values and targets (`numeric(12,3)`). */
  valueDecimals: 3,
  /** A duration is whole seconds within one day. */
  durationMaxSeconds: 86_400,
  graceDaysMax: 7,
  intervalDaysMin: 2,
  intervalDaysMax: 365,
  timesPerWeekMax: 7,
  timesPerMonthMax: 31,
  /** Minutes after local midnight (23:59). */
  preferredTimeMaxMinutes: 1439,
  /** Longest free-text input accepted before normalisation (cheap DoS guard). */
  rawTextMaxLength: 20_000,
} as const;

/** Earliest and latest local date any habit row may carry (database CHECKs use the same). */
export const HABIT_DATE_MIN = '2000-01-01';
export const HABIT_DATE_MAX = '2099-12-31';

/** ISO weekday numbers: 1 = Monday … 7 = Sunday (independent of the user's week start). */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** `days_of_month` value meaning "the last day of the month". */
export const LAST_DAY_OF_MONTH = -1;

export const habitTypeSchema = z.enum(HABIT_TYPES);
export const habitScheduleKindSchema = z.enum(HABIT_SCHEDULE_KINDS);
export const habitSchedulePeriodSchema = z.enum(HABIT_SCHEDULE_PERIODS);
export const habitTargetComparisonSchema = z.enum(HABIT_TARGET_COMPARISONS);

// ── Text ────────────────────────────────────────────────────────────────────────────────────────

/** C0/C1 controls and bidi embedding/override/isolate controls (spoofing in lists). ZWNJ allowed. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
/** Same for multi-line text, except line feed and tab. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_MULTI_LINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

function tooBig(ctx: z.RefinementCtx, maximum: number): typeof z.NEVER {
  ctx.addIssue({
    code: 'too_big',
    origin: 'string',
    maximum,
    inclusive: true,
    message: `Must be at most ${maximum} characters`,
  });
  return z.NEVER;
}

function forbidden(ctx: z.RefinementCtx): typeof z.NEVER {
  ctx.addIssue({
    code: 'invalid_format',
    format: 'regex',
    message: 'Must not contain control or bidirectional-override characters',
  });
  return z.NEVER;
}

/**
 * A required single-line label: NFKC, whitespace runs collapsed, trimmed, 1..`max` code points,
 * no control or bidi-override characters (same rules as the display name, ADR-0024).
 */
function singleLineText(max: number) {
  return z
    .string()
    .max(HABIT_LIMITS.rawTextMaxLength)
    .transform((value, ctx) => {
      if (FORBIDDEN_SINGLE_LINE.test(value)) return forbidden(ctx);
      const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
      if (normalized === '') {
        ctx.addIssue({
          code: 'too_small',
          origin: 'string',
          minimum: 1,
          inclusive: true,
          message: 'Must not be empty',
        });
        return z.NEVER;
      }
      if (codePointLength(normalized) > max) return tooBig(ctx, max);
      return normalized;
    });
}

/**
 * Multi-line free text: NFC (keeps the user's characters), CRLF → LF, trimmed, at most `max`
 * code points; line breaks and tabs allowed, other controls and bidi overrides rejected. Blank
 * input becomes `null` when `optional`, otherwise an error.
 */
function multiLineText(max: number, optional: boolean) {
  return z
    .string()
    .max(HABIT_LIMITS.rawTextMaxLength)
    .transform((value, ctx): string | null => {
      const text = value.replace(/\r\n?/g, '\n');
      if (FORBIDDEN_MULTI_LINE.test(text)) return forbidden(ctx);
      const normalized = text.normalize('NFC').trim();
      if (normalized === '') {
        if (optional) return null;
        ctx.addIssue({
          code: 'too_small',
          origin: 'string',
          minimum: 1,
          inclusive: true,
          message: 'Must not be empty',
        });
        return z.NEVER;
      }
      if (codePointLength(normalized) > max) return tooBig(ctx, max);
      return normalized;
    });
}

/** Habit name, 1..100 characters after normalisation. */
export const habitNameSchema = singleLineText(HABIT_LIMITS.nameMaxLength);
/** Habit description, up to 2000 characters; blank or `null` → `null`. */
export const habitDescriptionSchema = multiLineText(HABIT_LIMITS.descriptionMaxLength, true)
  .nullable()
  .transform((v) => v ?? null);
/** Unit label of numeric, negative and custom habits ("pages", "glasses"), 1..24 characters. */
export const habitUnitSchema = singleLineText(HABIT_LIMITS.unitMaxLength);
/** Category name, 1..50 characters (unique per user, case-insensitively, in the database). */
export const habitCategoryNameSchema = singleLineText(HABIT_LIMITS.categoryNameMaxLength);
/** Note body, 1..5000 characters. */
export const habitNoteBodySchema = multiLineText(HABIT_LIMITS.noteMaxLength, false).pipe(
  z.string(),
);

/** A design-palette token (never a raw colour, ADR-0013), e.g. `teal`. */
export const habitColorTokenSchema = z
  .string()
  .regex(new RegExp(`^[a-z][a-z0-9-]{0,${HABIT_LIMITS.colorTokenMaxLength - 1}}$`));
/** An icon token, e.g. `dumbbell`. */
export const habitIconTokenSchema = z
  .string()
  .regex(new RegExp(`^[a-z][a-z0-9-]{0,${HABIT_LIMITS.iconTokenMaxLength - 1}}$`));

// ── Dates and times ─────────────────────────────────────────────────────────────────────────────

/** A local calendar date within the supported window {@link HABIT_DATE_MIN}..{@link HABIT_DATE_MAX}. */
export const habitDateSchema = localDateSchema.refine(
  (v) => v >= HABIT_DATE_MIN && v <= HABIT_DATE_MAX,
  { message: `Must be between ${HABIT_DATE_MIN} and ${HABIT_DATE_MAX}` },
);

const PREFERRED_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Preferred time of day as local `HH:MM` (24 h). Stored as minutes after midnight. */
export const habitPreferredTimeSchema = z
  .string()
  .regex(PREFERRED_TIME, { message: 'Must be a time of day as HH:MM' });

/** `"07:30"` → 450. Throws for anything {@link habitPreferredTimeSchema} rejects. */
export function preferredTimeToMinutes(value: string): number {
  const m = PREFERRED_TIME.exec(value);
  if (!m) throw new RangeError('Not a HH:MM time of day');
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 450 → `"07:30"`. Throws outside 0..1439. */
export function minutesToPreferredTime(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > HABIT_LIMITS.preferredTimeMaxMinutes) {
    throw new RangeError('Minutes must be 0..1439');
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// ── Values ──────────────────────────────────────────────────────────────────────────────────────

/** True when `value` has at most {@link HABIT_LIMITS.valueDecimals} decimal places. */
function hasAtMostThreeDecimals(value: number): boolean {
  return Math.round(value * 1000) / 1000 === value;
}

/** A recorded amount or target: finite, 0..1,000,000, at most three decimals. */
export const habitAmountSchema = z
  .number()
  .finite()
  .min(0)
  .max(HABIT_LIMITS.valueMax)
  .refine(hasAtMostThreeDecimals, { message: 'Must have at most 3 decimal places' });

// ── Schedule rules ──────────────────────────────────────────────────────────────────────────────

/** Sorted, de-duplicated copy (lists are sets; storage order is canonical). */
const asSortedSet = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

export const dailyScheduleSchema = z.strictObject({ kind: z.literal('daily') });

export const weekdaysScheduleSchema = z.strictObject({
  kind: z.literal('weekdays'),
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7).transform(asSortedSet),
});

export const monthlyDaysScheduleSchema = z.strictObject({
  kind: z.literal('monthly_days'),
  /** 1..31, or -1 for the last day of the month. */
  daysOfMonth: z
    .array(
      z
        .number()
        .int()
        .refine((d) => d === LAST_DAY_OF_MONTH || (d >= 1 && d <= 31), {
          message: 'Must be 1..31 or -1 (last day)',
        }),
    )
    .min(1)
    .max(32)
    .transform(asSortedSet),
});

export const intervalScheduleSchema = z.strictObject({
  kind: z.literal('interval'),
  /** Every N days (2..365; 1 is `daily`). */
  intervalDays: z
    .number()
    .int()
    .min(HABIT_LIMITS.intervalDaysMin)
    .max(HABIT_LIMITS.intervalDaysMax),
  /** A day the habit is due; the others follow every `intervalDays` days, before and after. */
  anchorDate: habitDateSchema,
});

export const timesPerPeriodScheduleSchema = z
  .strictObject({
    kind: z.literal('times_per_period'),
    period: habitSchedulePeriodSchema,
    timesPerPeriod: z.number().int().min(1).max(HABIT_LIMITS.timesPerMonthMax),
  })
  .refine((s) => s.period === 'month' || s.timesPerPeriod <= HABIT_LIMITS.timesPerWeekMax, {
    message: `Must be at most ${HABIT_LIMITS.timesPerWeekMax} times per week`,
    path: ['timesPerPeriod'],
  });

/** When a habit is due, as one of the five schedule kinds. */
export const habitScheduleRuleSchema = z.discriminatedUnion('kind', [
  dailyScheduleSchema,
  weekdaysScheduleSchema,
  monthlyDaysScheduleSchema,
  intervalScheduleSchema,
  timesPerPeriodScheduleSchema,
]);
export type HabitScheduleRuleInput = z.input<typeof habitScheduleRuleSchema>;
export type HabitScheduleRule = z.output<typeof habitScheduleRuleSchema>;

/** A daily target: reach at least / stay at most `value`. */
export const habitTargetSchema = z.strictObject({
  comparison: habitTargetComparisonSchema,
  value: habitAmountSchema,
});
export type HabitTarget = z.output<typeof habitTargetSchema>;

// ── Type-specific rules ─────────────────────────────────────────────────────────────────────────

export interface HabitRules {
  schedule: HabitScheduleRule;
  target: HabitTarget | null;
  graceDays: number;
}

export interface HabitRuleIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Which schedule and target a habit type allows (mirrors `habit_schedule_versions_target_check`):
 *
 * | type      | schedule                 | target                                        |
 * | --------- | ------------------------ | --------------------------------------------- |
 * | binary    | any but times_per_period | none                                          |
 * | frequency | times_per_period only    | none (the target is `timesPerPeriod`)         |
 * | numeric   | any but times_per_period | at_least, > 0                                 |
 * | duration  | any but times_per_period | at_least, whole seconds 1..86400              |
 * | negative  | any but times_per_period | at_most, whole lapses ≥ 0 (usually 0)         |
 * | custom    | any but times_per_period | at_least > 0 or at_most ≥ 0                   |
 */
export function habitRuleIssues(type: HabitTypeValue, rules: HabitRules): HabitRuleIssue[] {
  const issues: HabitRuleIssue[] = [];
  const { schedule, target } = rules;
  const isPeriodic = schedule.kind === 'times_per_period';
  if (type === 'frequency' && !isPeriodic) {
    issues.push({
      path: ['schedule', 'kind'],
      message: 'Frequency habits need a times-per-period schedule',
    });
  }
  if (type !== 'frequency' && isPeriodic) {
    issues.push({
      path: ['schedule', 'kind'],
      message: 'Only frequency habits use a times-per-period schedule',
    });
  }
  const needs = (comparison: 'at_least' | 'at_most' | 'either') => {
    if (!target) {
      issues.push({ path: ['target'], message: 'This habit type needs a target' });
      return false;
    }
    if (comparison !== 'either' && target.comparison !== comparison) {
      issues.push({ path: ['target', 'comparison'], message: `Must be ${comparison}` });
      return false;
    }
    return true;
  };
  switch (type) {
    case 'binary':
    case 'frequency':
      if (target) issues.push({ path: ['target'], message: 'This habit type has no target value' });
      break;
    case 'numeric':
      if (needs('at_least') && target!.value <= 0)
        issues.push({ path: ['target', 'value'], message: 'Must be greater than 0' });
      break;
    case 'duration':
      if (
        needs('at_least') &&
        (!Number.isInteger(target!.value) ||
          target!.value < 1 ||
          target!.value > HABIT_LIMITS.durationMaxSeconds)
      ) {
        issues.push({
          path: ['target', 'value'],
          message: `Must be whole seconds between 1 and ${HABIT_LIMITS.durationMaxSeconds}`,
        });
      }
      break;
    case 'negative':
      if (needs('at_most') && !Number.isInteger(target!.value))
        issues.push({ path: ['target', 'value'], message: 'Must be a whole number of lapses' });
      break;
    case 'custom':
      if (needs('either') && target!.comparison === 'at_least' && target!.value <= 0)
        issues.push({ path: ['target', 'value'], message: 'Must be greater than 0' });
      break;
  }
  return issues;
}

/** Which habit types carry a unit label: required for custom, optional for numeric and negative. */
export function unitAllowedFor(type: HabitTypeValue): 'required' | 'optional' | 'none' {
  if (type === 'custom') return 'required';
  return type === 'numeric' || type === 'negative' ? 'optional' : 'none';
}

const habitRulesShape = {
  schedule: habitScheduleRuleSchema,
  target: habitTargetSchema.nullable(),
  graceDays: z.number().int().min(0).max(HABIT_LIMITS.graceDaysMax),
};

/** One schedule version's rules, without the habit type (checked with {@link habitRuleIssues}). */
export const habitRulesSchema = z.strictObject(habitRulesShape);

/**
 * The type-dependent part of a habit — its type, unit and rules — checked together. P3-06
 * (create) and P3-03 (a new schedule version: the stored type plus the new rules) compose it.
 */
export const habitDefinitionSchema = z
  .strictObject({
    type: habitTypeSchema,
    unit: habitUnitSchema.nullable(),
    ...habitRulesShape,
  })
  .superRefine((value, ctx) => {
    const unit = unitAllowedFor(value.type);
    if (unit === 'required' && value.unit === null) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Custom habits need a unit' });
    }
    if (unit === 'none' && value.unit !== null) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: 'This habit type has no unit' });
    }
    for (const issue of habitRuleIssues(value.type, value)) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  });
export type HabitDefinitionInput = z.input<typeof habitDefinitionSchema>;
export type HabitDefinition = z.output<typeof habitDefinitionSchema>;

/** A habit's active date range: `endsOn` (inclusive) is null or not before `startsOn`. */
export const habitDateRangeSchema = z
  .strictObject({ startsOn: habitDateSchema, endsOn: habitDateSchema.nullable() })
  .refine((r) => r.endsOn === null || r.endsOn >= r.startsOn, {
    message: 'Must not end before it starts',
    path: ['endsOn'],
  });

/** A pause of one habit or a vacation of all (inclusive dates; `endsOn` null = until resumed). */
export const habitPauseSchema = habitDateRangeSchema;

// ── Recorded occurrences ────────────────────────────────────────────────────────────────────────

/**
 * What a user records for one habit on one local date: an amount, or a skip. The amount's meaning
 * depends on the type: 1/0 (binary, frequency), whole seconds ≤ 1 day (duration), whole lapses
 * (negative), any amount ≤ 1,000,000 with ≤ 3 decimals (numeric, custom).
 */
export const habitOccurrenceEntrySchema = z.union([
  z.strictObject({ skipped: z.literal(true) }),
  z.strictObject({ skipped: z.literal(false).optional(), value: habitAmountSchema }),
]);
export type HabitOccurrenceEntry = z.output<typeof habitOccurrenceEntrySchema>;

/** Null when `value` is valid for `type`, else the reason (mirrors `habit_occurrences_value_check`). */
export function occurrenceValueIssue(type: HabitTypeValue, value: number): string | null {
  if (!habitAmountSchema.safeParse(value).success)
    return 'Must be 0..1000000 with at most 3 decimals';
  switch (type) {
    case 'binary':
    case 'frequency':
      return value === 0 || value === 1 ? null : 'Must be 1 (done) or 0 (not done)';
    case 'duration':
      return Number.isInteger(value) && value <= HABIT_LIMITS.durationMaxSeconds
        ? null
        : `Must be whole seconds up to ${HABIT_LIMITS.durationMaxSeconds}`;
    case 'negative':
      return Number.isInteger(value) ? null : 'Must be a whole number of lapses';
    default:
      return null;
  }
}
