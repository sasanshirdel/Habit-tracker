import {
  calendarSystems,
  locales,
  weekStarts,
  type CalendarSystem,
  type Locale,
  type WeekStart,
} from '@habit/localization';
import type {
  CalendarPreference,
  LocalePreference,
  ThemePreferenceValue,
  UpdatePreferencesRequest,
  UpdateProfileRequest,
  UserPreferences,
  UserProfile,
  WeekStartPreference,
} from '@habit/shared-types';
import { DISPLAY_NAME_MAX_LENGTH } from '@habit/shared-validation';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  CalendarSystem as DbCalendar,
  ThemePreference,
  WeekStart as DbWeekStart,
} from '../../generated/prisma/enums.js';
import { IDENTITY_LIMITS } from './identity.constants.js';
import {
  updatePreferencesBodySchema,
  updateProfileBodySchema,
  userPreferencesSchema,
  userProfileSchema,
} from './profile.schemas.js';

describe('profile and preferences contracts (P2-07, ADR-0024)', () => {
  it('response schemas mirror @habit/shared-types', () => {
    expectTypeOf<z.output<typeof userProfileSchema>>().toEqualTypeOf<UserProfile>();
    expectTypeOf<z.output<typeof userPreferencesSchema>>().toEqualTypeOf<UserPreferences>();
    expectTypeOf<z.input<typeof updateProfileBodySchema>>().toEqualTypeOf<UpdateProfileRequest>();
    expectTypeOf<
      z.input<typeof updatePreferencesBodySchema>
    >().toEqualTypeOf<UpdatePreferencesRequest>();
  });

  it('shared-types literal unions match @habit/localization and the database enums', () => {
    expectTypeOf<LocalePreference>().toEqualTypeOf<Locale>();
    expectTypeOf<CalendarPreference>().toEqualTypeOf<CalendarSystem>();
    expectTypeOf<WeekStartPreference>().toEqualTypeOf<WeekStart>();
    expect(Object.values(DbCalendar).sort()).toEqual([...calendarSystems].sort());
    expect(Object.values(DbWeekStart).sort()).toEqual([...weekStarts].sort());
    expect(Object.values(ThemePreference).sort()).toEqual(
      (['dark', 'light', 'system'] satisfies ThemePreferenceValue[]).sort(),
    );
    expect(locales).toEqual(['en', 'fa']);
  });

  it('display-name limit matches the database CHECK constant', () => {
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(IDENTITY_LIMITS.displayNameMaxLength);
  });

  it('profile body: strict, normalised, blank clears', () => {
    expect(updateProfileBodySchema.parse({ displayName: '  Sara  ' })).toEqual({
      displayName: 'Sara',
    });
    expect(updateProfileBodySchema.parse({ displayName: '' })).toEqual({ displayName: null });
    expect(updateProfileBodySchema.safeParse({}).success).toBe(false);
    expect(updateProfileBodySchema.safeParse({ displayName: 'x', avatarUrl: 'y' }).success).toBe(
      false,
    );
    expect(updateProfileBodySchema.safeParse({ displayName: 'a\u202eb' }).success).toBe(false);
  });

  it('preferences body: strict, non-empty subset, valid values only', () => {
    expect(updatePreferencesBodySchema.parse({ weekStart: 'sunday' })).toEqual({
      weekStart: 'sunday',
    });
    expect(updatePreferencesBodySchema.safeParse({}).success).toBe(false);
    expect(updatePreferencesBodySchema.safeParse({ userId: 'x', theme: 'dark' }).success).toBe(
      false,
    );
    expect(updatePreferencesBodySchema.safeParse({ timezone: 'Asia/Atlantis' }).success).toBe(
      false,
    );
  });
});
