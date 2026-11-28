import { describe, expect, it } from 'vitest';
import {
  HABIT_DATE_MAX,
  HABIT_DATE_MIN,
  HABIT_TYPES,
  habitAmountSchema,
  habitCategoryNameSchema,
  habitColorTokenSchema,
  habitDateRangeSchema,
  habitDateSchema,
  habitDefinitionSchema,
  habitDescriptionSchema,
  habitIconTokenSchema,
  habitNameSchema,
  habitNoteBodySchema,
  habitOccurrenceEntrySchema,
  habitPreferredTimeSchema,
  habitRuleIssues,
  habitScheduleRuleSchema,
  minutesToPreferredTime,
  occurrenceValueIssue,
  preferredTimeToMinutes,
  type HabitDefinitionInput,
  type HabitTypeValue,
} from './index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('habit text (P3-01)', () => {
  it('names are normalised like display names and bounded in code points', () => {
    expect(habitNameSchema.parse('  Read \u00a0 10   pages ')).toBe('Read 10 pages');
    expect(habitNameSchema.parse('ورزش\u200cصبحگاهی')).toBe('ورزش\u200cصبحگاهی');
    expect(habitNameSchema.parse('Ｒｅａｄ')).toBe('Read');
    expect(habitNameSchema.parse('ا'.repeat(100))).toHaveLength(100);
    expect(ok(habitNameSchema, 'ا'.repeat(101))).toBe(false);
    // Astral characters count once (database char_length counts code points).
    expect(habitNameSchema.parse('🏃'.repeat(100))).toBe('🏃'.repeat(100));
  });

  it('names reject empty, control and bidi-override characters', () => {
    for (const bad of ['', '   ', 'a\nb', 'a\u0000', 'evil\u202egnp', '\u2066x']) {
      expect(ok(habitNameSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('descriptions keep line breaks, normalise CRLF and turn blank into null', () => {
    expect(habitDescriptionSchema.parse('line one\r\nline two\t!')).toBe('line one\nline two\t!');
    expect(habitDescriptionSchema.parse('   ')).toBeNull();
    expect(habitDescriptionSchema.parse(null)).toBeNull();
    expect(ok(habitDescriptionSchema, 'x'.repeat(2001))).toBe(false);
    expect(ok(habitDescriptionSchema, 'bad\u202e')).toBe(false);
  });

  it('note bodies are required and bounded', () => {
    expect(habitNoteBodySchema.parse(' felt great \n')).toBe('felt great');
    expect(ok(habitNoteBodySchema, ' ')).toBe(false);
    expect(ok(habitNoteBodySchema, 'x'.repeat(5000))).toBe(true);
    expect(ok(habitNoteBodySchema, 'x'.repeat(5001))).toBe(false);
  });

  it('category names are single-line and at most 50 characters', () => {
    expect(habitCategoryNameSchema.parse(' سلامت ')).toBe('سلامت');
    expect(ok(habitCategoryNameSchema, 'x'.repeat(51))).toBe(false);
  });

  it('colour and icon are tokens, never raw colours', () => {
    expect(ok(habitColorTokenSchema, 'teal')).toBe(true);
    expect(ok(habitColorTokenSchema, 'accent-2')).toBe(true);
    for (const bad of ['#ff0000', 'rgb(0,0,0)', 'Teal', '', '1red', 'x'.repeat(33)]) {
      expect(ok(habitColorTokenSchema, bad), bad).toBe(false);
    }
    expect(ok(habitIconTokenSchema, 'dumbbell')).toBe(true);
    expect(ok(habitIconTokenSchema, '<svg>')).toBe(false);
  });
});

describe('habit dates and times (P3-01)', () => {
  it('accepts real ISO dates inside the supported window only', () => {
    expect(ok(habitDateSchema, '2026-11-28')).toBe(true);
    expect(ok(habitDateSchema, HABIT_DATE_MIN)).toBe(true);
    expect(ok(habitDateSchema, HABIT_DATE_MAX)).toBe(true);
    for (const bad of [
      '1999-12-31',
      '2100-01-01',
      '2026-02-29',
      '2026-11-28T00:00',
      '1405-09-07x',
    ]) {
      expect(ok(habitDateSchema, bad), bad).toBe(false);
    }
  });

  it('a date range must not end before it starts', () => {
    expect(ok(habitDateRangeSchema, { startsOn: '2026-01-01', endsOn: '2026-01-01' })).toBe(true);
    expect(ok(habitDateRangeSchema, { startsOn: '2026-01-02', endsOn: null })).toBe(true);
    expect(ok(habitDateRangeSchema, { startsOn: '2026-01-02', endsOn: '2026-01-01' })).toBe(false);
  });

  it('preferred times are HH:MM and round-trip through minutes', () => {
    expect(ok(habitPreferredTimeSchema, '07:30')).toBe(true);
    for (const bad of ['7:30', '24:00', '12:60', '07:30:00']) {
      expect(ok(habitPreferredTimeSchema, bad), bad).toBe(false);
    }
    expect(preferredTimeToMinutes('00:00')).toBe(0);
    expect(preferredTimeToMinutes('23:59')).toBe(1439);
    for (let m = 0; m < 1440; m += 7)
      expect(preferredTimeToMinutes(minutesToPreferredTime(m))).toBe(m);
    expect(() => minutesToPreferredTime(1440)).toThrow(RangeError);
    expect(() => preferredTimeToMinutes('25:00')).toThrow(RangeError);
  });
});

describe('habitScheduleRuleSchema (P3-01)', () => {
  it('accepts every kind and canonicalises day lists', () => {
    expect(habitScheduleRuleSchema.parse({ kind: 'daily' })).toEqual({ kind: 'daily' });
    expect(habitScheduleRuleSchema.parse({ kind: 'weekdays', daysOfWeek: [5, 1, 3, 1] })).toEqual({
      kind: 'weekdays',
      daysOfWeek: [1, 3, 5],
    });
    expect(
      habitScheduleRuleSchema.parse({ kind: 'monthly_days', daysOfMonth: [31, -1, 15] }),
    ).toEqual({ kind: 'monthly_days', daysOfMonth: [-1, 15, 31] });
    expect(
      ok(habitScheduleRuleSchema, { kind: 'interval', intervalDays: 3, anchorDate: '2026-11-28' }),
    ).toBe(true);
    expect(
      ok(habitScheduleRuleSchema, { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 }),
    ).toBe(true);
    expect(
      ok(habitScheduleRuleSchema, {
        kind: 'times_per_period',
        period: 'month',
        timesPerPeriod: 31,
      }),
    ).toBe(true);
  });

  it.each([
    ['unknown kind', { kind: 'hourly' }],
    ['extra field', { kind: 'daily', daysOfWeek: [1] }],
    ['no weekdays', { kind: 'weekdays', daysOfWeek: [] }],
    ['weekday 0', { kind: 'weekdays', daysOfWeek: [0] }],
    ['weekday 8', { kind: 'weekdays', daysOfWeek: [8] }],
    ['fractional weekday', { kind: 'weekdays', daysOfWeek: [1.5] }],
    ['day of month 0', { kind: 'monthly_days', daysOfMonth: [0] }],
    ['day of month 32', { kind: 'monthly_days', daysOfMonth: [32] }],
    ['day of month -2', { kind: 'monthly_days', daysOfMonth: [-2] }],
    ['interval 1 (use daily)', { kind: 'interval', intervalDays: 1, anchorDate: '2026-01-01' }],
    ['interval 366', { kind: 'interval', intervalDays: 366, anchorDate: '2026-01-01' }],
    ['interval without anchor', { kind: 'interval', intervalDays: 2 }],
    ['8 per week', { kind: 'times_per_period', period: 'week', timesPerPeriod: 8 }],
    ['0 per week', { kind: 'times_per_period', period: 'week', timesPerPeriod: 0 }],
    ['32 per month', { kind: 'times_per_period', period: 'month', timesPerPeriod: 32 }],
    ['per year', { kind: 'times_per_period', period: 'year', timesPerPeriod: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(ok(habitScheduleRuleSchema, value)).toBe(false);
  });
});

describe('habit amounts and recorded occurrences (P3-01)', () => {
  it('amounts are finite, 0..1,000,000 with at most three decimals', () => {
    for (const good of [0, 1, 0.5, 2.125, 1.005, 1_000_000])
      expect(ok(habitAmountSchema, good)).toBe(true);
    for (const bad of [-1, 1_000_000.001, 0.0001, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
      expect(ok(habitAmountSchema, bad), String(bad)).toBe(false);
    }
  });

  it('an entry is either a value or a skip, never both', () => {
    expect(ok(habitOccurrenceEntrySchema, { value: 3 })).toBe(true);
    expect(ok(habitOccurrenceEntrySchema, { skipped: false, value: 3 })).toBe(true);
    expect(ok(habitOccurrenceEntrySchema, { skipped: true })).toBe(true);
    expect(ok(habitOccurrenceEntrySchema, { skipped: true, value: 3 })).toBe(false);
    expect(ok(habitOccurrenceEntrySchema, {})).toBe(false);
  });

  it.each<[HabitTypeValue, number, boolean]>([
    ['binary', 1, true],
    ['binary', 0, true],
    ['binary', 2, false],
    ['frequency', 1, true],
    ['frequency', 0.5, false],
    ['duration', 86_400, true],
    ['duration', 86_401, false],
    ['duration', 90.5, false],
    ['negative', 3, true],
    ['negative', 1.5, false],
    ['numeric', 2.5, true],
    ['custom', 999_999.999, true],
    ['custom', -1, false],
  ])('%s value %d valid=%s', (type, value, valid) => {
    expect(occurrenceValueIssue(type, value) === null).toBe(valid);
  });
});

describe('habitDefinitionSchema: type, unit, schedule and target together (P3-01)', () => {
  const daily = { kind: 'daily' } as const;
  const weekly3 = { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 } as const;
  const def = (over: Partial<HabitDefinitionInput>): HabitDefinitionInput => ({
    type: 'binary',
    unit: null,
    schedule: daily,
    target: null,
    graceDays: 0,
    ...over,
  });
  const valid: [string, HabitDefinitionInput][] = [
    ['binary daily', def({})],
    ['frequency 3×/week', def({ type: 'frequency', schedule: weekly3 })],
    [
      'numeric with unit',
      def({ type: 'numeric', unit: 'pages', target: { comparison: 'at_least', value: 10 } }),
    ],
    [
      'numeric without unit',
      def({ type: 'numeric', target: { comparison: 'at_least', value: 8 } }),
    ],
    ['duration 20 min', def({ type: 'duration', target: { comparison: 'at_least', value: 1200 } })],
    ['negative 0 lapses', def({ type: 'negative', target: { comparison: 'at_most', value: 0 } })],
    [
      'custom at most',
      def({ type: 'custom', unit: 'cups', target: { comparison: 'at_most', value: 2.5 } }),
    ],
    [
      'custom at least',
      def({ type: 'custom', unit: 'km', target: { comparison: 'at_least', value: 5 } }),
    ],
    ['grace days', def({ graceDays: 7 })],
  ];
  it.each(valid)('accepts %s', (_l, value) => {
    expect(habitDefinitionSchema.safeParse(value).success).toBe(true);
  });

  const invalid: [string, HabitDefinitionInput, string][] = [
    ['binary with target', def({ target: { comparison: 'at_least', value: 1 } }), 'target'],
    ['binary with times per period', def({ schedule: weekly3 }), 'schedule.kind'],
    ['frequency daily', def({ type: 'frequency' }), 'schedule.kind'],
    [
      'frequency with target',
      def({ type: 'frequency', schedule: weekly3, target: { comparison: 'at_least', value: 3 } }),
      'target',
    ],
    ['numeric without target', def({ type: 'numeric' }), 'target'],
    [
      'numeric at most',
      def({ type: 'numeric', target: { comparison: 'at_most', value: 3 } }),
      'target.comparison',
    ],
    [
      'numeric zero',
      def({ type: 'numeric', target: { comparison: 'at_least', value: 0 } }),
      'target.value',
    ],
    [
      'duration fractional',
      def({ type: 'duration', target: { comparison: 'at_least', value: 1.5 } }),
      'target.value',
    ],
    [
      'duration over a day',
      def({ type: 'duration', target: { comparison: 'at_least', value: 86_401 } }),
      'target.value',
    ],
    [
      'duration with unit',
      def({ type: 'duration', unit: 'min', target: { comparison: 'at_least', value: 60 } }),
      'unit',
    ],
    [
      'negative at least',
      def({ type: 'negative', target: { comparison: 'at_least', value: 1 } }),
      'target.comparison',
    ],
    [
      'negative fractional',
      def({ type: 'negative', target: { comparison: 'at_most', value: 0.5 } }),
      'target.value',
    ],
    [
      'custom without unit',
      def({ type: 'custom', target: { comparison: 'at_most', value: 1 } }),
      'unit',
    ],
    [
      'custom at least 0',
      def({ type: 'custom', unit: 'x', target: { comparison: 'at_least', value: 0 } }),
      'target.value',
    ],
    ['binary with unit', def({ unit: 'times' }), 'unit'],
    ['grace 8', def({ graceDays: 8 }), 'graceDays'],
  ];
  it.each(invalid)('rejects %s at %s', (_l, value, path) => {
    const result = habitDefinitionSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.path.join('.'))).toContain(path);
  });

  it('habitRuleIssues covers every type', () => {
    for (const type of HABIT_TYPES) {
      expect(
        Array.isArray(habitRuleIssues(type, { schedule: daily, target: null, graceDays: 0 })),
      ).toBe(true);
    }
  });
});
