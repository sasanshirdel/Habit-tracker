import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_MAX_LENGTH,
  defaultDisplayPreferencesFor,
  displayNameSchema,
  normalizeDisplayName,
  preferencesSchema,
  preferencesUpdateSchema,
  profileUpdateSchema,
} from './index.js';

const issueCodes = (result: { success: boolean; error?: { issues: { code: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((i) => i.code);

describe('displayNameSchema (P2-07)', () => {
  it('normalises: NFKC, collapsed whitespace, trimmed', () => {
    expect(displayNameSchema.parse('  Sara \u00a0 Ahmadi \u3000')).toBe('Sara Ahmadi');
    // Full-width Latin and a decomposed é become their canonical forms.
    expect(displayNameSchema.parse('Ｓａｒａ')).toBe('Sara');
    expect(displayNameSchema.parse('Ame\u0301lie')).toBe('Amélie');
    // Arabic presentation form ﻙ (U+FED9) → ك; Persian letters stay as typed.
    expect(normalizeDisplayName('\ufed9')).toBe('\u0643');
    expect(displayNameSchema.parse('سارا احمدی')).toBe('سارا احمدی');
  });

  it('keeps ZWNJ (Persian spelling) and case', () => {
    expect(displayNameSchema.parse('نیلوفر\u200cها')).toBe('نیلوفر\u200cها');
    expect(displayNameSchema.parse('McKenzie')).toBe('McKenzie');
  });

  it('blank or null means no display name', () => {
    expect(displayNameSchema.parse('')).toBeNull();
    expect(displayNameSchema.parse('   ')).toBeNull();
    expect(displayNameSchema.parse(null)).toBeNull();
  });

  it('counts code points after normalisation', () => {
    expect(displayNameSchema.parse('😀'.repeat(DISPLAY_NAME_MAX_LENGTH))).toHaveLength(
      DISPLAY_NAME_MAX_LENGTH * 2,
    );
    expect(
      issueCodes(displayNameSchema.safeParse('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))),
    ).toEqual(['too_big']);
    expect(issueCodes(displayNameSchema.safeParse('a'.repeat(2000)))).toEqual(['too_big']);
  });

  it.each([
    ['line break', 'Sara\nAhmadi'],
    ['NUL', 'Sara\u0000'],
    ['tab', 'Sara\tAhmadi'],
    ['right-to-left override', 'evil\u202egnp.exe'],
    ['first-strong isolate', '\u2068Sara\u2069'],
    ['C1 control', 'Sara\u0085'],
  ])('rejects a %s', (_label, value) => {
    expect(issueCodes(displayNameSchema.safeParse(value))).toEqual(['invalid_format']);
  });

  it.each([undefined, 42, {}])('rejects %j', (value) => {
    expect(displayNameSchema.safeParse(value).success).toBe(false);
  });

  it('profile update requires the field', () => {
    expect(profileUpdateSchema.parse({ displayName: ' Ali ' })).toEqual({ displayName: 'Ali' });
    expect(profileUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe('preferences schemas (P2-07)', () => {
  const valid = {
    locale: 'fa',
    timezone: 'Asia/Tehran',
    theme: 'system',
    calendar: 'solar_hijri',
    weekStart: 'saturday',
  } as const;

  it('accepts a full set', () => {
    expect(preferencesSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['locale', 'de'],
    ['timezone', 'Mars/Olympus'],
    ['timezone', '+03:30'],
    ['theme', 'blue'],
    ['calendar', 'persian'],
    ['weekStart', 'friday'],
  ])('rejects %s = %j', (key, value) => {
    expect(preferencesSchema.safeParse({ ...valid, [key]: value }).success).toBe(false);
  });

  it('update: any non-empty subset, nothing unknown', () => {
    expect(preferencesUpdateSchema.parse({ theme: 'light' })).toEqual({ theme: 'light' });
    expect(preferencesUpdateSchema.parse(valid)).toEqual(valid);
    expect(preferencesUpdateSchema.safeParse({}).success).toBe(false);
    expect(preferencesUpdateSchema.safeParse({ theme: undefined }).success).toBe(false);
    expect(preferencesUpdateSchema.safeParse({ colour: 'dark' }).success).toBe(false);
    expect(preferencesUpdateSchema.safeParse({ theme: null }).success).toBe(false);
  });
});

describe('defaultDisplayPreferencesFor (P2-07)', () => {
  it('derives calendar and week start from the registration language', () => {
    expect(defaultDisplayPreferencesFor('fa')).toEqual({
      calendar: 'solar_hijri',
      weekStart: 'saturday',
    });
    expect(defaultDisplayPreferencesFor('en')).toEqual({
      calendar: 'gregorian',
      weekStart: 'monday',
    });
  });
});
