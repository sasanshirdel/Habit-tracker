/**
 * Shared ICU formats and formatting defaults (backlog P1-10, ADR-0004).
 *
 * Messages reference these by name (`{date, date, long}`), and components use the same names
 * with next-intl's `format.dateTime(d, 'long')`. Digits, separators and the calendar follow the
 * locale through `Intl`: Persian (`fa`) gets Persian digits (۱۲۳) and, by CLDR default, the
 * Solar Hijri calendar; English gets Latin digits and the Gregorian calendar. Whether Persian
 * users see Solar Hijri or Gregorian dates by default is an open owner decision (ROADMAP
 * "Outstanding decisions" #8); change it here with a `calendar` option.
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
 * Time zone for server and client formatting until users have a profile time zone (Phase 2):
 * the same value on both sides avoids hydration mismatches. Storage is always UTC + the user's
 * IANA zone (ADR-0006); the per-user zone replaces this default when it exists.
 */
export const DEFAULT_TIME_ZONE = 'UTC';
