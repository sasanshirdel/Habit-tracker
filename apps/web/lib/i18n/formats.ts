/**
 * Shared ICU formats and formatting defaults (backlog P1-10, ADR-0004).
 *
 * Messages reference these by name (`{date, date, long}`), and components use the same names
 * with next-intl's `format.dateTime(d, 'long')`. Digits, separators and the calendar follow the
 * locale through `Intl`: Persian (`fa`) gets Persian digits (۱۲۳) and, by CLDR default, the
 * Solar Hijri calendar; English gets Latin digits and the Gregorian calendar. Signed-in pages
 * pass the user's own calendar and time zone (P2-07, `useDateDisplay` in
 * `lib/account/preferences.ts`); the per-locale default for new accounts is interim (ROADMAP
 * "Outstanding decisions" #8).
 */
import type { Formats } from 'next-intl';

export const formats = {
  dateTime: {
    short: { day: 'numeric', month: 'short', year: 'numeric' },
    long: { day: 'numeric', month: 'long', year: 'numeric' },
    time: { hour: 'numeric', minute: '2-digit' },
  },
  number: {
    integer: { maximumFractionDigits: 0 },
    percent: { style: 'percent', maximumFractionDigits: 0 },
  },
  list: {
    and: { type: 'conjunction', style: 'long' },
  },
} satisfies Formats;

/**
 * Time zone of the next-intl provider on server and client (the same value on both sides avoids
 * hydration mismatches). Server HTML holds no user dates (ADR-0020); signed-in components format
 * in the user's profile zone with `useDateDisplay` (P2-07). Storage is always UTC + the user's
 * IANA zone (ADR-0006).
 */
export const DEFAULT_TIME_ZONE = 'UTC';
