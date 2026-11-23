import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colorTokenNames, colors, cssVarName, themeNames } from './tokens.js';

const css = readFileSync(fileURLToPath(new URL('../tokens.css', import.meta.url)), 'utf8');

function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `selector ${selector} missing in tokens.css`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('design tokens', () => {
  it('defines every colour token for every theme as a 6-digit hex value', () => {
    for (const theme of themeNames) {
      for (const token of colorTokenNames) {
        expect(colors[theme][token]).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('keeps tokens.css in sync with tokens.ts', () => {
    const blocks = {
      dark: cssBlock("[data-theme='dark']"),
      light: cssBlock("[data-theme='light']"),
    };
    for (const theme of themeNames) {
      for (const token of colorTokenNames) {
        const decl = `${cssVarName(token)}: ${colors[theme][token].toLowerCase()};`;
        expect(blocks[theme]).toContain(decl);
      }
    }
  });
});
