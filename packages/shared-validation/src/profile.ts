import {
  calendarSystems,
  defaultCalendarFor,
  defaultWeekStartFor,
  weekStarts,
  type CalendarSystem,
  type Locale,
  type WeekStart,
} from '@habit/localization';
import { z } from 'zod';
import { localeSchema } from './locale.js';
import { timeZoneSchema } from './time-zone.js';

/**
 * Profile and preference input rules (backlog P2-07, ADR-0024). The API validates
 * `PATCH /account/profile` and `PATCH /account/preferences` with these; the web settings forms
 * reuse them for immediate feedback only — the server stays the authority.
 */

/** Longest display name, in Unicode code points (`user_profiles_display_name_check`). */
export const DISPLAY_NAME_MAX_LENGTH = 100;

/** Hard cap on the raw string before any normalisation work. */
export const DISPLAY_NAME_INPUT_MAX_LENGTH = 1024;

/**
 * Characters a display name may not contain: C0/C1 control characters (line breaks, tabs, NUL…)
 * and the bidirectional embedding/override/isolate controls (U+202A–U+202E, U+2066–U+2069), which
 * could make a name render as something else in a list (Trojan-Source style spoofing). The
 * zero-width non-joiner (U+200C) and joiner (U+200D) stay allowed: Persian spelling needs ZWNJ
 * ("می‌خواهم").
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_IN_DISPLAY_NAME = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Canonical form of a display name: Unicode NFKC (so Arabic presentation forms, full-width Latin
 * and composed/decomposed letters compare and count the same), runs of whitespace collapsed to one
 * space, trimmed. Case and ZWNJ are kept.
 */
export function normalizeDisplayName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

/**
 * A display name as stored: normalised (see {@link normalizeDisplayName}), 1–100 code points, no
 * control or bidi-override characters. Blank input (or `null`) means "no display name" and
 * becomes `null`. Issues use zod's `too_big` / `invalid_format` codes so clients can localise
 * them; the value never appears in an issue.
 */
export const displayNameSchema = z
  .string()
  .max(DISPLAY_NAME_INPUT_MAX_LENGTH)
  .nullable()
  .transform((value, ctx) => {
    if (value === null) return null;
    if (FORBIDDEN_IN_DISPLAY_NAME.test(value)) {
      ctx.addIssue({
        code: 'invalid_format',
        format: 'regex',
        message: 'Must not contain control or bidirectional-override characters',
      });
      return z.NEVER;
    }
    const normalized = normalizeDisplayName(value);
    if (normalized === '') return null;
    if (codePointLength(normalized) > DISPLAY_NAME_MAX_LENGTH) {
      ctx.addIssue({
        code: 'too_big',
        origin: 'string',
        maximum: DISPLAY_NAME_MAX_LENGTH,
        inclusive: true,
        message: `Must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
      });
      return z.NEVER;
    }
    return normalized;
  });

/** The profile form and `PATCH /account/profile` body (non-strict here; the API makes it strict). */
export const profileUpdateSchema = z.object({ displayName: displayNameSchema });
export type ProfileUpdateInput = z.input<typeof profileUpdateSchema>;
export type ProfileUpdate = z.output<typeof profileUpdateSchema>;

/** Colour theme (ADR-0013). Same values as `themePreferences` in `@habit/ui` (asserted in web). */
export const themePreferenceSchema = z.enum(['dark', 'light', 'system']);
export const calendarSystemSchema = z.enum(calendarSystems);
export const weekStartSchema = z.enum(weekStarts);

/** Every preference with its rule; the form edits all of them at once. */
export const preferencesSchema = z.object({
  locale: localeSchema,
  timezone: timeZoneSchema,
  theme: themePreferenceSchema,
  calendar: calendarSystemSchema,
  weekStart: weekStartSchema,
});
export type PreferencesInput = z.output<typeof preferencesSchema>;

/**
 * `PATCH /account/preferences` body: any subset of the preferences, at least one. Strict, so a
 * misspelled field is a 400 instead of a silent no-op.
 */
export const preferencesUpdateSchema = z
  .strictObject(preferencesSchema.partial().shape)
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'Change at least one preference',
  });
export type PreferencesUpdate = z.output<typeof preferencesUpdateSchema>;

/**
 * Calendar and week start a new account starts with, from the language it registered in
 * (interim defaults, ROADMAP "Outstanding decisions" #8; `@habit/localization`).
 */
export function defaultDisplayPreferencesFor(locale: Locale): {
  calendar: CalendarSystem;
  weekStart: WeekStart;
} {
  return { calendar: defaultCalendarFor(locale), weekStart: defaultWeekStartFor(locale) };
}
