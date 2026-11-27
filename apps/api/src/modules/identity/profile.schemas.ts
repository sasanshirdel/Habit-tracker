import { z } from 'zod';
import {
  DISPLAY_NAME_MAX_LENGTH,
  calendarSystemSchema,
  localeSchema,
  preferencesUpdateSchema,
  profileUpdateSchema,
  themePreferenceSchema,
  timeZoneSchema,
  weekStartSchema,
} from '@habit/shared-validation';
import { component } from '../../openapi/index.js';

/**
 * Schemas of the profile and preferences routes (backlog P2-07, ADR-0024). Input rules come from
 * `@habit/shared-validation` (the web settings forms validate with the same schemas); request
 * bodies are strict. Response schemas mirror `@habit/shared-types` (asserted in `profile.test.ts`).
 */

export const updateProfileBodySchema = z.strictObject({
  displayName: profileUpdateSchema.shape.displayName.meta({
    description:
      `Up to ${DISPLAY_NAME_MAX_LENGTH} characters (Unicode code points) after NFKC normalisation, ` +
      'collapsing whitespace and trimming. Blank or `null` removes the display name. Control ' +
      'characters and bidirectional overrides/isolates are rejected; ZWNJ is allowed.',
  }),
});
export type UpdateProfileInput = z.output<typeof updateProfileBodySchema>;

export const updatePreferencesBodySchema = preferencesUpdateSchema.meta({
  description: 'Any non-empty subset of the preferences; omitted ones stay unchanged.',
});
export type UpdatePreferencesInput = z.output<typeof updatePreferencesBodySchema>;

export const userProfileSchema = component(
  z.strictObject({
    displayName: z.string().nullable().meta({
      description: 'Normalised display name, or `null` when none is set.',
    }),
  }),
  { id: 'UserProfile', description: 'The signed-in user’s profile.' },
);

export const userPreferencesSchema = component(
  z.strictObject({
    locale: localeSchema.meta({ description: 'Interface and email language.' }),
    timezone: timeZoneSchema.meta({
      description: 'IANA time zone; times are shown, and habit days computed, in it.',
    }),
    theme: themePreferenceSchema.meta({ description: 'Colour theme (`system` follows the OS).' }),
    calendar: calendarSystemSchema.meta({
      description:
        'Calendar dates are shown in. Display only: the API always speaks UTC instants and ISO dates.',
    }),
    weekStart: weekStartSchema.meta({ description: 'First day of the week in weekly views.' }),
  }),
  { id: 'UserPreferences', description: 'The signed-in user’s preferences.' },
);
