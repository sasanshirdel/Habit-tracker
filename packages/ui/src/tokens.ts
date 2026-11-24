/**
 * Design tokens — the single source of truth for colours and typography.
 * Values start from PRD §2.2 ("Suggested initial tokens") and are checked for WCAG 2.2 AA
 * contrast by `contrast.test.ts` (backlog P1-09). Components reference tokens through CSS
 * variables (`tokens.css` → Tailwind theme in `styles.css`), never raw hex values.
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
  'accent-foreground',
  'danger',
  'danger-foreground',
  'border',
  'border-strong',
] as const;
export type ColorTokenName = (typeof colorTokenNames)[number];

export const colors: Record<ThemeName, Record<ColorTokenName, string>> = {
  dark: {
    background: '#101010',
    surface: '#181818',
    'surface-secondary': '#222222',
    'surface-elevated': '#292929',
    'text-primary': '#F5F2EA',
    // PRD: "muted neutral tones". AA on every dark surface (≥ 5.8:1).
    'text-secondary': '#A8A39A',
    accent: '#D6B45B',
    // Text/icons on an accent fill (primary buttons).
    'accent-foreground': '#101010',
    // Errors and destructive actions (no PRD value; chosen for AA on every surface).
    danger: '#F28B82',
    'danger-foreground': '#101010',
    // Decorative separators only (cards, dividers) — below 3:1 by design.
    border: '#303030',
    // Boundaries that identify a control (inputs, outline buttons): ≥ 3:1 (WCAG 1.4.11).
    'border-strong': '#7A756C',
  },
  light: {
    background: '#FBF9F4',
    surface: '#FFFFFF',
    'surface-secondary': '#F3F0E9',
    // PRD gives no light elevated/border/secondary-text values — chosen in Phase 1, AA-checked.
    'surface-elevated': '#FFFFFF',
    'text-primary': '#28251F',
    'text-secondary': '#6B655A',
    // PRD suggests #A9802C, which reaches only ~3.4:1 on the light background (fails AA for
    // text). Darkened to the same hue for ≥ 4.5:1 on every light surface; see ADR-0013.
    accent: '#8A6420',
    'accent-foreground': '#FFFFFF',
    danger: '#B3261E',
    'danger-foreground': '#FFFFFF',
    border: '#E4DED2',
    'border-strong': '#8A8376',
  },
};

/** Font stacks. The variable fonts are self-hosted from @fontsource-variable (no font CDN). */
export const fontFamilies = {
  /** English / LTR. */
  latin: ['Inter Variable', 'Inter', 'system-ui', 'sans-serif'],
  /** Persian / RTL: Vazirmatn covers Arabic script and Latin, so mixed text stays consistent. */
  persian: [
    'Vazirmatn Variable',
    'Vazirmatn',
    'Inter Variable',
    'Tahoma',
    'system-ui',
    'sans-serif',
  ],
} as const;

export function cssVarName(token: ColorTokenName): `--token-${ColorTokenName}` {
  return `--token-${token}`;
}
