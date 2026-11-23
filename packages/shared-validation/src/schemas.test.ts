import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { Locale } from '@habit/localization';
import { localDateSchema, localeSchema, timeZoneSchema } from './index.js';

describe('localeSchema', () => {
  it('accepts supported locales and infers the shared Locale type', () => {
    expect(localeSchema.parse('fa')).toBe('fa');
    expect(localeSchema.parse('en')).toBe('en');
    expectTypeOf<z.infer<typeof localeSchema>>().toEqualTypeOf<Locale>();
  });

  it.each(['de', 'FA', 'fa-IR', '', 1, null])('rejects %j', (value) => {
    expect(localeSchema.safeParse(value).success).toBe(false);
  });
});

describe('timeZoneSchema', () => {
  it.each(['Asia/Tehran', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Etc/GMT+3', 'UTC'])(
    'accepts %s',
    (tz) => {
      expect(timeZoneSchema.parse(tz)).toBe(tz);
    },
  );

  it.each([
    '',
    'Tehran',
    'Asia/Atlantis',
    '+03:30',
    'IRST',
    'asia/tehran/../x',
    'A'.repeat(65),
    42,
  ])('rejects %j', (tz) => {
    expect(timeZoneSchema.safeParse(tz).success).toBe(false);
  });

  it('reports a field-level message', () => {
    const result = timeZoneSchema.safeParse('Asia/Atlantis');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/IANA time zone/);
  });
});

describe('localDateSchema', () => {
  it.each(['2026-11-24', '2024-02-29', '2000-02-29', '0001-01-01', '2026-12-31'])(
    'accepts %s',
    (d) => {
      expect(localDateSchema.parse(d)).toBe(d);
    },
  );

  it.each([
    '2026-02-29', // not a leap year
    '1900-02-29', // century, not a leap year
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-11-00',
    '0000-01-01',
    '2026-1-5',
    '2026-11-24T00:00:00Z',
    '1405-09-03x',
    '',
    20261124,
  ])('rejects %j', (d) => {
    expect(localDateSchema.safeParse(d).success).toBe(false);
  });
});
