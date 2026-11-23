import { describe, expect, it } from 'vitest';
import {
  defaultLocale,
  getDirection,
  getIntlLocale,
  isLocale,
  locales,
  parseLocale,
} from './config';
import en from './dictionaries/en.json';
import fa from './dictionaries/fa.json';

function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object'
      ? keyPaths(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe('i18n config', () => {
  it('maps Persian to RTL and English to LTR', () => {
    expect(getDirection('fa')).toBe('rtl');
    expect(getDirection('en')).toBe('ltr');
  });

  it('validates locale segments', () => {
    expect(isLocale('fa')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(locales).toContain(defaultLocale);
  });

  it('parses route segments with the shared locale schema', () => {
    expect(parseLocale('fa')).toBe('fa');
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('de')).toBeNull();
    expect(parseLocale('FA')).toBeNull();
    expect(parseLocale('')).toBeNull();
  });

  it('formats numbers with locale-appropriate digits', () => {
    expect(new Intl.NumberFormat(getIntlLocale('fa')).format(123)).toBe('۱۲۳');
    expect(new Intl.NumberFormat(getIntlLocale('en')).format(123)).toBe('123');
  });

  it('has identical keys in every dictionary (no missing translations)', () => {
    expect(keyPaths(fa).sort()).toEqual(keyPaths(en).sort());
  });
});
