/**
 * Locale configuration (Phase 0 stub). Persian is a first-class locale, not a
 * translation layer: direction, fonts and formatting all derive from here.
 * Phase 1 replaces the dictionary loader with next-intl (see ADR-0004).
 */
export const locales = ['en', 'fa'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

export type Direction = 'ltr' | 'rtl';

const directions: Record<Locale, Direction> = { en: 'ltr', fa: 'rtl' };

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function getDirection(locale: Locale): Direction {
  return directions[locale];
}

/** BCP 47 tag used for Intl formatting. fa-IR uses Persian digits and the Persian calendar where requested. */
export function getIntlLocale(locale: Locale): string {
  return locale === 'fa' ? 'fa-IR' : 'en-US';
}
