import { describe, expect, it } from 'vitest';
import { WCAG_AA, contrastRatio, relativeLuminance } from './contrast.js';
import { colors, themeNames, type ColorTokenName } from './tokens.js';

const surfaces: ColorTokenName[] = [
  'background',
  'surface',
  'surface-secondary',
  'surface-elevated',
];

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(relativeLuminance('#ffffff')).toBe(1);
    expect(() => relativeLuminance('red')).toThrow();
  });
});

describe.each(themeNames)('WCAG 2.2 AA contrast — %s theme (P1-09)', (theme) => {
  const t = colors[theme];
  const ratio = (fg: ColorTokenName, bg: ColorTokenName) => contrastRatio(t[fg], t[bg]);

  it.each(['text-primary', 'text-secondary', 'accent', 'danger'] as const)(
    '%s is readable text (≥ 4.5:1) on every surface',
    (fg) => {
      for (const bg of surfaces) {
        expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(WCAG_AA.text);
      }
    },
  );

  it('text on accent and danger fills is ≥ 4.5:1', () => {
    expect(ratio('accent-foreground', 'accent')).toBeGreaterThanOrEqual(WCAG_AA.text);
    expect(ratio('danger-foreground', 'danger')).toBeGreaterThanOrEqual(WCAG_AA.text);
  });

  it('control boundaries (border-strong) and the focus ring (accent) are ≥ 3:1 on every surface', () => {
    for (const bg of surfaces) {
      expect(ratio('border-strong', bg), `border-strong on ${bg}`).toBeGreaterThanOrEqual(
        WCAG_AA.nonText,
      );
      expect(ratio('accent', bg), `accent on ${bg}`).toBeGreaterThanOrEqual(WCAG_AA.nonText);
    }
  });
});

it('documents why the PRD light accent was darkened', () => {
  // PRD §2.2 suggests #A9802C for light: below AA for text on the light background.
  expect(contrastRatio('#A9802C', colors.light.background)).toBeLessThan(WCAG_AA.text);
});
