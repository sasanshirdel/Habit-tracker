import { describe, expect, it } from 'vitest';
import { defaultLocale, getDirection, getIntlLocale, isLocale, locales } from './index.js';

describe('@habit/localization', () => {
  it('supports exactly English and Persian, with a supported default', () => {
    expect([...locales]).toEqual(['en', 'fa']);
    expect(locales).toContain(defaultLocale);
  });

  it('maps Persian to RTL and English to LTR', () => {
    expect(getDirection('fa')).toBe('rtl');
    expect(getDirection('en')).toBe('ltr');
  });

  it('validates locale values (case-sensitive, strings only)', () => {
    expect(isLocale('fa')).toBe(true);
    expect(isLocale('en')).toBe(true);
    for (const bad of ['de', 'FA', 'en-US', '', ' fa', null, undefined, 1, {}]) {
      expect(isLocale(bad)).toBe(false);
    }
  });

  it('formats numbers with locale-appropriate digits', () => {
    expect(new Intl.NumberFormat(getIntlLocale('fa')).format(1234)).toBe('۱٬۲۳۴');
    expect(new Intl.NumberFormat(getIntlLocale('en')).format(1234)).toBe('1,234');
  });
});
