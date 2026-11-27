/**
 * Calendar and week preferences shared by web and api (backlog P2-07, ADR-0024). Like the locale
 * list, both sides must agree on these values: the API stores them per user, the web app formats
 * dates with them, and Phase 3's weekly matrix starts its rows on {@link WeekStart}.
 */
import type { Locale } from './locales.js';

/**
 * How dates are shown. `solar_hijri` is the Iranian (Persian) calendar — `Intl` calls it
 * `persian`; `gregorian` is `gregory`. Storage is never affected: instants stay UTC, local dates
 * stay ISO (Gregorian) `YYYY-MM-DD` (ADR-0006). This is a display preference only.
 */
export const calendarSystems = ['gregorian', 'solar_hijri'] as const;
export type CalendarSystem = (typeof calendarSystems)[number];

/** First day of the week in weekly views. Saturday is the norm in Iran, Monday per ISO 8601. */
export const weekStarts = ['saturday', 'sunday', 'monday'] as const;
export type WeekStart = (typeof weekStarts)[number];

const defaultCalendars: Record<Locale, CalendarSystem> = { en: 'gregorian', fa: 'solar_hijri' };
const defaultWeekStarts: Record<Locale, WeekStart> = { en: 'monday', fa: 'saturday' };

/**
 * Calendar a new account starts with, from the language it registered in (interim, ROADMAP
 * "Outstanding decisions" #8): Persian → Solar Hijri, English → Gregorian. Users change it in
 * Settings → Preferences.
 */
export function defaultCalendarFor(locale: Locale): CalendarSystem {
  return defaultCalendars[locale];
}

/** Week start a new account starts with (interim): Persian → Saturday, English → Monday. */
export function defaultWeekStartFor(locale: Locale): WeekStart {
  return defaultWeekStarts[locale];
}

const intlCalendars: Record<CalendarSystem, string> = {
  gregorian: 'gregory',
  solar_hijri: 'persian',
};

/** The `calendar` option of `Intl.DateTimeFormat` for a preference (`gregory` | `persian`). */
export function getIntlCalendar(calendar: CalendarSystem): string {
  return intlCalendars[calendar];
}

export function isCalendarSystem(value: unknown): value is CalendarSystem {
  return typeof value === 'string' && (calendarSystems as readonly string[]).includes(value);
}

export function isWeekStart(value: unknown): value is WeekStart {
  return typeof value === 'string' && (weekStarts as readonly string[]).includes(value);
}
