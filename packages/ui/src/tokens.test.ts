import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colorTokenNames, colors, cssVarName, themeNames, type ThemeName } from './tokens.js';

const css = readFileSync(fileURLToPath(new URL('../tokens.css', import.meta.url)), 'utf8');

function cssBlock(selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  expect(start, `selector ${selector} missing in tokens.css`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

function expectTheme(block: string, theme: ThemeName) {
  for (const token of colorTokenNames) {
    expect(block).toContain(`${cssVarName(token)}: ${colors[theme][token].toLowerCase()};`);
  }
  expect(block).toContain(`color-scheme: ${theme};`);
}

describe('design tokens', () => {
  it('defines every colour token for every theme as a 6-digit hex value', () => {
    for (const theme of themeNames) {
      for (const token of colorTokenNames) {
        expect(colors[theme][token]).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('keeps tokens.css in sync with tokens.ts (dark, light)', () => {
    expectTheme(cssBlock("[data-theme='dark']"), 'dark');
    expectTheme(cssBlock("[data-theme='light']"), 'light');
  });

  it('applies the light tokens to data-theme="system" when the OS prefers light', () => {
    const media = css.indexOf('@media (prefers-color-scheme: light)');
    expect(media).toBeGreaterThan(0);
    expectTheme(cssBlock("[data-theme='system']", media), 'light');
  });

  it('defaults to dark on :root (no cookie, or a first paint without data-theme)', () => {
    expect(css).toMatch(/:root,\s*\[data-theme='dark'\] \{/);
  });
});
