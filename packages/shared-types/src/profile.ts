/**
 * Profile and preferences contracts (backlog P2-07, ADR-0024). Both routes are for the signed-in
 * user only and return only that user's data. Input rules live in `@habit/shared-validation`.
 * The literal unions repeat `@habit/localization`'s lists (this package has no dependencies); the
 * API asserts the two agree.
 */

/** `GET /api/v1/account/profile` — 200; also the body of `PATCH /account/profile`. */
export interface UserProfile {
  /** 1–100 characters, normalised (NFKC, single spaces, trimmed); `null` when not set. */
  displayName: string | null;
}

/** `PATCH /api/v1/account/profile` request body. Blank or `null` removes the display name. */
export interface UpdateProfileRequest {
  displayName: string | null;
}

export type LocalePreference = 'en' | 'fa';
export type ThemePreferenceValue = 'dark' | 'light' | 'system';
export type CalendarPreference = 'gregorian' | 'solar_hijri';
export type WeekStartPreference = 'saturday' | 'sunday' | 'monday';

/** `GET /api/v1/account/preferences` — 200; also the body of `PATCH /account/preferences`. */
export interface UserPreferences {
  /** Interface and email language. */
  locale: LocalePreference;
  /** IANA time zone, e.g. `Asia/Tehran`: times are shown, and habit days computed, in it. */
  timezone: string;
  theme: ThemePreferenceValue;
  /** Calendar dates are shown in (display only; storage stays UTC / ISO dates). */
  calendar: CalendarPreference;
  /** First day of the week in weekly views. */
  weekStart: WeekStartPreference;
}

/** `PATCH /api/v1/account/preferences` request body: any non-empty subset. */
export type UpdatePreferencesRequest = Partial<UserPreferences>;
