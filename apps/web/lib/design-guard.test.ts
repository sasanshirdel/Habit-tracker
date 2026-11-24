import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "Design tokens only" (AGENTS.md, backlog P1-09): no raw colour values in components, pages or
 * stylesheets of the web app and the UI package. Colours live in `packages/ui/src/tokens.ts` and
 * `tokens.css` only.
 */
const appRoot = join(import.meta.dirname, '..');
const uiRoot = join(appRoot, '..', '..', 'packages', 'ui');
const ALLOWED = new Set([join(uiRoot, 'tokens.css'), join(uiRoot, 'src', 'tokens.ts')]);
const RAW_COLOUR =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b(?![-\w])|\b(?:rgba?|hsla?|oklch|oklab)\(\s*\d/i;
/** Comment lines may cite issue numbers (`#1234`). */
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.next', 'dist', 'e2e'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

const files = [...sourceFiles(appRoot), ...sourceFiles(uiRoot)].filter((f) => !ALLOWED.has(f));

describe('no raw colours outside the design tokens', () => {
  it('scans the web app and the UI package', () => {
    expect(files.some((f) => f.endsWith('button.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('globals.css'))).toBe(true);
  });

  it.each(files.map((f) => [relative(join(appRoot, '..', '..'), f), f]))('%s', (_name, file) => {
    const offending = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => RAW_COLOUR.test(line) && !COMMENT.test(line));
    expect(offending).toEqual([]);
  });
});
