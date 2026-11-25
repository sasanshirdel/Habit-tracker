import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import base, { PHYSICAL_DIRECTION_CLASS } from '@habit/config/eslint';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Guards against physical left/right styling, which does not mirror in RTL (backlog P1-10,
 * ADR-0004): an ESLint rule for class names (shared config) and a scan of the stylesheets.
 */
const linter = new Linter({ configType: 'flat' });
const lint = (code: string) =>
  linter
    .verify(code, [...base], 'component.tsx')
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => m.line);

describe('lint rule: logical utilities only in class names', () => {
  it('matches physical utilities and not logical ones', () => {
    const physical = new RegExp(PHYSICAL_DIRECTION_CLASS);
    for (const c of ['ml-2', 'px-4 pr-2', 'md:-mr-1', '!left-0', 'right-1/2', 'text-right']) {
      expect(physical.test(c), c).toBe(true);
    }
    for (const c of ['border-l', 'rounded-tr-md', 'float-left', 'scroll-ml-2', 'rtl:pl-2']) {
      expect(physical.test(c), c).toBe(true);
    }
    for (const c of ['ms-2', 'pe-4', 'start-0', 'end-1/2', 'text-start', 'border-s', 'mx-auto']) {
      expect(physical.test(c), c).toBe(false);
    }
    for (const c of ['rounded-se-md', 'placeholder:text-sm', 'prose', 'inset-x-0', 'left']) {
      expect(physical.test(c), c).toBe(false);
    }
  });

  it('reports className strings, template literals and cn()/clsx()/cva() arguments', () => {
    const code = [
      'const a = <div className="flex ml-2" />;', // 1
      'const b = <div className={`p-2 ${x} text-right`} />;', // 2
      "const c = cn('ps-2', cond && 'left-0');", // 3
      "const d = clsx({ 'md:pr-4': true });", // 4
      'const e = <div className="ms-2 pe-4 start-0 text-start" />;', // 5: logical — fine
      "const f = label('Turn left-ish, then right');", // 6: prose outside class contexts — fine
    ].join('\n');
    expect(lint(code)).toEqual([1, 2, 3, 4]);
  });
});

describe('stylesheets: no physical left/right properties', () => {
  const PHYSICAL_CSS =
    /(^|[\s;{])(margin|padding|border|inset)-(left|right)\b|(^|[\s;{])(left|right)\s*:|(text-align|float|clear)\s*:\s*(left|right)\b/m;
  const appRoot = join(import.meta.dirname, '..', '..');
  const roots = [appRoot, join(appRoot, '..', '..', 'packages', 'ui')];

  function cssFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (['node_modules', '.next', 'dist'].includes(entry.name)) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return cssFiles(path);
      return entry.name.endsWith('.css') ? [path] : [];
    });
  }

  it('finds the stylesheets', () => {
    expect(roots.flatMap(cssFiles).length).toBeGreaterThan(0);
  });

  it.each(roots.flatMap(cssFiles).map((f) => [relative(appRoot, f), f]))(
    '%s uses logical properties',
    (_name, file) => {
      expect(readFileSync(file, 'utf8')).not.toMatch(PHYSICAL_CSS);
    },
  );
});
