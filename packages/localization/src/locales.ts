/**
 * Locale metadata shared by web and api (ADR-0004). Persian is a first-class locale, not a
 * translation layer: direction, fonts and formatting all derive from here. UI messages stay in
 * `apps/web/lib/i18n/messages` (next-intl, P1-10); this package holds only what both the frontend
 * and the backend need to agree on.
 */
export const locales = ['en', 'fa'] as const;
export type Locale = (typeof locales)[number];

/**
 * Default locale for new users and the last fallback of `/` negotiation (after the `NEXT_LOCALE`
 * cookie and `Accept-Language`; apps/web next-intl routing). Interim value — open owner decision
 * (ROADMAP "Outstanding decisions" #1). Change it here only; every consumer imports it from here.
 */
export const defaultLocale: Locale = 'en';

export type Direction = 'ltr' | 'rtl';

const directions: Record<Locale, Direction> = { en: 'ltr', fa: 'rtl' };

/** BCP 47 tags used for `Intl` formatting. `fa-IR` yields Persian digits. */
const intlLocales: Record<Locale, string> = { en: 'en-US', fa: 'fa-IR' };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

export function getDirection(locale: Locale): Direction {
  return directions[locale];
}

export function getIntlLocale(locale: Locale): string {
  return intlLocales[locale];
}
