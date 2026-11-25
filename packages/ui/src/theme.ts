/**
 * Theme preference (backlog P1-09). The user's choice lives in a cookie so the server renders
 * `<html data-theme>` correctly on the first byte — no flash, and no inline script (which the
 * nonce CSP would have to allow). `system` follows `prefers-color-scheme` in CSS (`tokens.css`).
 * Phase 2 moves the preference to the user profile; the cookie stays as the anonymous fallback.
 */
export const themePreferences = ['dark', 'light', 'system'] as const;
export type ThemePreference = (typeof themePreferences)[number];

/** Dark is the PRD default. */
export const defaultThemePreference: ThemePreference = 'dark';

export const THEME_COOKIE = 'theme';
/** One year. */
export const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (themePreferences as readonly string[]).includes(value);
}

/** Cookie value → preference; anything unknown (or missing) → the default. */
export function parseThemePreference(value: string | undefined | null): ThemePreference {
  return isThemePreference(value) ? value : defaultThemePreference;
}

/** `Set-Cookie`-style string for `document.cookie` (not HttpOnly: the switcher writes it). */
export function themeCookie(preference: ThemePreference, secure: boolean): string {
  const parts = [
    `${THEME_COOKIE}=${preference}`,
    'Path=/',
    `Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
