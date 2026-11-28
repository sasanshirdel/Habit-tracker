import { createFormatter, createTranslator, type IntlError } from 'next-intl';
import { describe, expect, it } from 'vitest';
import {
  defaultLocale,
  getDirection,
  getIntlLocale,
  isLocale,
  locales,
  parseLocale,
  type Locale,
} from './config';
import { DEFAULT_TIME_ZONE, formats } from './formats';
import { messages } from './messages';
import { routing } from './routing';

type Catalogue = Record<string, unknown>;

/** `{ a: { b: 'x' } }` → `[['a.b', 'x']]`. */
function entries(obj: Catalogue, prefix = ''): Array<[string, unknown]> {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object'
      ? entries(v as Catalogue, `${prefix}${k}.`)
      : [[`${prefix}${k}`, v] as [string, unknown]],
  );
}

/** ICU argument names used by a message (`{count, plural, …}`, `{date, date, long}`, `{name}`). */
function icuArguments(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].map((m) => m[1] ?? '')),
  ].sort();
}

const throwOnError = (error: IntlError) => {
  throw error;
};

function translator(locale: Locale) {
  // Keys are checked dynamically here, so the typed signature is widened on purpose.
  return createTranslator({
    locale,
    messages: messages[locale],
    formats,
    timeZone: DEFAULT_TIME_ZONE,
    onError: throwOnError,
  }) as unknown as (key: string, values?: Record<string, unknown>) => string;
}

function formatter(locale: Locale) {
  return createFormatter({ locale, formats, timeZone: DEFAULT_TIME_ZONE, onError: throwOnError });
}

// A fixed instant: 2026-03-21T12:00:00Z (1 Farvardin, Nowruz 1405 in the Solar Hijri calendar).
const NOWRUZ = new Date(Date.UTC(2026, 2, 21, 12));
const SAMPLE_VALUES = {
  count: 3,
  value: 0.42,
  date: NOWRUZ,
  time: NOWRUZ,
  seconds: 5,
  hours: 2,
  minutes: 7,
  min: 8,
  max: 128,
  email: 'sara@example.com',
  requestId: 'req-1',
  browser: 'Firefox',
  os: 'Android',
  client: 'Firefox on Android',
  days: 180,
  ago: '5 minutes ago',
  when: 'Mar 21, 2026, 3:30 PM',
};

describe('locale config', () => {
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

  it('routes with the shared locales and default, always prefixed, with detection on', () => {
    expect([...routing.locales]).toEqual([...locales]);
    expect(routing.defaultLocale).toBe(defaultLocale);
    expect(routing.localePrefix).toBe('always');
    expect(routing.localeDetection).toBe(true);
  });
});

describe('message catalogues (missing or mismatched translations fail CI)', () => {
  const reference = new Map(entries(messages.en));

  it.each(locales)('%s has exactly the reference keys', (locale) => {
    expect(
      entries(messages[locale])
        .map(([k]) => k)
        .sort(),
    ).toEqual([...reference.keys()].sort());
  });

  it.each(locales)('%s has a non-empty string for every key', (locale) => {
    for (const [key, value] of entries(messages[locale])) {
      expect(typeof value, key).toBe('string');
      expect((value as string).trim(), key).not.toBe('');
    }
  });

  it.each(locales)('%s uses the same ICU arguments as the reference for every key', (locale) => {
    for (const [key, value] of entries(messages[locale])) {
      expect(icuArguments(value as string), key).toEqual(
        icuArguments(reference.get(key) as string),
      );
    }
  });

  it.each(locales)('%s: every message is valid ICU and formats without error', (locale) => {
    const t = translator(locale);
    for (const [key] of entries(messages[locale])) {
      expect(t(key, SAMPLE_VALUES), key).not.toBe('');
    }
  });

  it('a missing key is an error, not a silent fallback', () => {
    expect(() => translator('fa')('home.doesNotExist')).toThrow(/MISSING_MESSAGE/);
  });
});

describe('formatting (Intl through next-intl)', () => {
  it('uses Persian digits and separators in fa, Latin in en', () => {
    expect(formatter('fa').number(1234567)).toBe('۱٬۲۳۴٬۵۶۷');
    expect(formatter('en').number(1234567)).toBe('1,234,567');
    expect(formatter('fa').number(0.42, 'percent')).toBe('۴۲٪');
    expect(formatter('en').number(0.42, 'percent')).toBe('42%');
    // `getIntlLocale` (used outside React, e.g. by the API) agrees with the route locale.
    expect(new Intl.NumberFormat(getIntlLocale('fa')).format(123)).toBe('۱۲۳');
  });

  it('formats dates per locale: Solar Hijri with Persian digits in fa, Gregorian in en', () => {
    expect(formatter('en').dateTime(NOWRUZ, 'long')).toBe('March 21, 2026');
    const fa = formatter('fa').dateTime(NOWRUZ, 'long');
    expect(fa).toMatch(/۱۴۰۵/); // year 1405 (interim calendar default — ROADMAP decision #8)
    expect(fa).toMatch(/فروردین/); // month Farvardin
    expect(fa).not.toMatch(/[0-9]/);
  });

  it('formats dates in the configured time zone', () => {
    expect(DEFAULT_TIME_ZONE).toBe('UTC');
    const lateUtc = new Date(Date.UTC(2026, 2, 20, 23, 30));
    expect(formatter('en').dateTime(lateUtc, 'time')).toBe('11:30 PM');
  });

  it('applies ICU plural rules per locale', () => {
    const en = translator('en');
    const fa = translator('fa');
    expect(en('common.days', { count: 1 })).toBe('1 day');
    expect(en('common.days', { count: 3 })).toBe('3 days');
    expect(fa('common.days', { count: 1 })).toBe('۱ روز');
    expect(fa('common.days', { count: 3 })).toBe('۳ روز');
  });

  it('interpolates named formats inside messages', () => {
    expect(translator('en')('home.today', { date: NOWRUZ })).toBe('Today is March 21, 2026.');
    expect(translator('fa')('home.today', { date: NOWRUZ })).toMatch(/^امروز .*۱۴۰۵ است\.$/);
  });
});
