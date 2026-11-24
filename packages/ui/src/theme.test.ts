import { describe, expect, it } from 'vitest';
import {
  THEME_COOKIE,
  defaultThemePreference,
  isThemePreference,
  parseThemePreference,
  themeCookie,
} from './theme.js';

describe('theme preference', () => {
  it('defaults to dark and accepts only known values', () => {
    expect(defaultThemePreference).toBe('dark');
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('system')).toBe('system');
    for (const bad of [undefined, null, '', 'LIGHT', 'blue', 'light;', '<script>']) {
      expect(parseThemePreference(bad)).toBe('dark');
    }
    expect(isThemePreference(1)).toBe(false);
  });

  it('builds the cookie (Lax, 1 year, Secure only on HTTPS)', () => {
    expect(THEME_COOKIE).toBe('theme');
    expect(themeCookie('light', true)).toBe(
      'theme=light; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    );
    expect(themeCookie('system', false)).not.toContain('Secure');
  });
});
