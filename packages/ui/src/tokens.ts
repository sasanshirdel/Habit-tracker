/**
 * Design tokens — the single source of truth for colours and typography.
 * Values come from PRD §2.2 ("Suggested initial tokens"). Components must
 * reference tokens (via CSS variables in tokens.css), never raw hex values.
 *
 * Keep `tokens.css` in sync with this file; `tokens.test.ts` enforces it.
 */

export const themeNames = ['dark', 'light'] as const;
export type ThemeName = (typeof themeNames)[number];

export const colorTokenNames = [
  'background',
  'surface',
  'surface-secondary',
  'surface-elevated',
  'text-primary',
  'text-secondary',
  'accent',
  'border',
] as const;
export type ColorTokenName = (typeof colorTokenNames)[number];

export const colors: Record<ThemeName, Record<ColorTokenName, string>> = {
  dark: {
    background: '#101010',
    surface: '#181818',
    'surface-secondary': '#222222',
    'surface-elevated': '#292929',
    'text-primary': '#F5F2EA',
    // PRD: "muted neutral tones" — provisional value, to be validated for contrast in Phase 1.
    'text-secondary': '#A8A39A',
    accent: '#D6B45B',
    border: '#303030',
  },
  light: {
    background: '#FBF9F4',
    surface: '#FFFFFF',
    'surface-secondary': '#F3F0E9',
    // PRD gives no light elevated/border/secondary-text values — provisional, validate in Phase 1.
    'surface-elevated': '#FFFFFF',
    'text-primary': '#28251F',
    'text-secondary': '#6B655A',
    accent: '#A9802C',
    border: '#E4DED2',
  },
};

export const fontFamilies = {
  /** English / LTR */
  latin: ['Inter', 'system-ui', 'sans-serif'],
  /** Persian / RTL */
  persian: ['Vazirmatn', 'Tahoma', 'system-ui', 'sans-serif'],
} as const;

export function cssVarName(token: ColorTokenName): `--token-${ColorTokenName}` {
  return `--token-${token}`;
}
