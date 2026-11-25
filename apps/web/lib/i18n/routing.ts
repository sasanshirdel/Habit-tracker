/**
 * Locale routing for next-intl (backlog P1-10, ADR-0004).
 *
 * - Every page lives under a locale prefix (`/en/…`, `/fa/…`; `localePrefix: 'always'`), so URLs
 *   stay cacheable, shareable and SEO-friendly and `<html lang dir>` never depends on a cookie.
 * - A request without a prefix (`/`, `/pricing`) is redirected (307) to the negotiated locale:
 *   the `NEXT_LOCALE` cookie (an explicit choice made with the language switcher) first, then the
 *   `Accept-Language` header, then `defaultLocale`. The redirect only changes the path, never
 *   the origin (next-intl sanitises the path against `//host` and `\host` tricks; tested).
 * - `defaultLocale` comes from `@habit/localization` — the single place to change it. Its value
 *   (`en`) is interim: the default for `/` and new users is an open owner decision (ROADMAP
 *   "Outstanding decisions" #1).
 */
import { defaultLocale, locales } from '@habit/localization';
import { defineRouting } from 'next-intl/routing';

/** One year: the cookie remembers an explicit language choice across sessions. */
const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: 'always',
  localeDetection: true,
  localeCookie: {
    name: 'NEXT_LOCALE',
    sameSite: 'lax',
    maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
    // Not a secret (only "en"/"fa"), but never sent over plain HTTP in production.
    secure: process.env.NODE_ENV === 'production',
  },
  // `Link: <…/en>; rel="alternate"; hreflang="en", …` on every localized page.
  alternateLinks: true,
});
