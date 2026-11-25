// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkArchitecture, extractImports, findCycles } from './check.js';
import rules from './rules.js';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** @param {Record<string, unknown>} manifest */
const json = (manifest) => JSON.stringify(manifest, null, 2);
const dist = (/** @type {string} */ name) => ({
  types: `./dist/${name}.d.ts`,
  default: `./dist/${name}.js`,
});

/**
 * A miniature copy of the real workspace layout, valid under the real rules. Each test changes a
 * file or two to break exactly one rule ("rule fixtures").
 * @returns {Record<string, string>}
 */
function baseline() {
  return {
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n\nallowBuilds:\n  x: true\n",
    'packages/config/package.json': json({
      name: '@habit/config',
      exports: { './eslint': './eslint.base.js' },
    }),
    'packages/config/eslint.base.js': 'export default [];\n',
    'packages/shared-types/package.json': json({
      name: '@habit/shared-types',
      exports: { '.': dist('index') },
      devDependencies: { '@habit/config': 'workspace:*' },
    }),
    'packages/shared-types/src/index.ts': 'export type Id = string;\n',
    'packages/shared-types/eslint.config.js':
      "import base from '@habit/config/eslint';\nexport default base;\n",
    'packages/localization/package.json': json({
      name: '@habit/localization',
      exports: { '.': dist('index') },
    }),
    'packages/localization/src/index.ts': "export const locales = ['en', 'fa'] as const;\n",
    'packages/shared-validation/package.json': json({
      name: '@habit/shared-validation',
      exports: { '.': dist('index') },
      dependencies: { '@habit/localization': 'workspace:*' },
    }),
    'packages/shared-validation/src/index.ts':
      "import { locales } from '@habit/localization';\nexport const isLocale = (v: string) => (locales as readonly string[]).includes(v);\n",
    'packages/ui/package.json': json({
      name: '@habit/ui',
      exports: { '.': dist('index'), './styles.css': './styles.css' },
    }),
    'packages/ui/src/index.ts': "export { Button } from './button.js';\n",
    'packages/ui/src/button.ts': 'export const Button = () => null;\n',
    'apps/api/package.json': json({
      name: '@habit/api',
      exports: { './queue': dist('queue/index'), './worker': dist('worker/index') },
      dependencies: { '@habit/shared-types': 'workspace:*' },
    }),
    'apps/api/src/main.ts': "import { AppModule } from './app.module.js';\nvoid AppModule;\n",
    'apps/api/src/app.module.ts':
      "import { HabitsModule } from './modules/habits/index.js';\nimport { GoalsModule } from './modules/goals/index.js';\nimport { DatabaseModule } from './database/index.js';\nexport const AppModule = [HabitsModule, GoalsModule, DatabaseModule];\n",
    'apps/api/src/generated/prisma/client.ts': 'export class PrismaClient {}\n',
    'apps/api/src/database/index.ts':
      "import { PrismaClient } from '../generated/prisma/client.js';\nexport const DatabaseModule = new PrismaClient();\n",
    'apps/api/src/queue/index.ts':
      "import { DatabaseModule } from '../database/index.js';\nexport const QueueModule = DatabaseModule;\n",
    'apps/api/src/modules/habits/index.ts':
      "export { HabitsService as HabitsModule } from './habits.service.js';\n",
    'apps/api/src/modules/habits/habits.service.ts':
      "import type { Id } from '@habit/shared-types';\nimport { DatabaseModule } from '../../database/index.js';\nimport { PrismaClient } from '../../generated/prisma/client.js';\nexport class HabitsService { db = DatabaseModule; client = PrismaClient; id: Id = ''; }\n",
    'apps/api/src/modules/goals/index.ts':
      "import { HabitsModule } from '../habits/index.js';\nexport const GoalsModule = HabitsModule;\n",
    'apps/api/src/worker/index.ts':
      "import { HabitsModule } from '../modules/habits/index.js';\nimport { QueueModule } from '../queue/index.js';\nexport const WorkerModule = [HabitsModule, QueueModule];\n",
    'apps/api/test/setup.int.test.ts':
      "import { PrismaClient } from '../src/generated/prisma/client.js';\nvoid PrismaClient;\n",
    'apps/worker/package.json': json({
      name: '@habit/worker',
      dependencies: { '@habit/api': 'workspace:*' },
    }),
    'apps/worker/src/main.ts':
      "import { WorkerModule } from '@habit/api/worker';\nimport type { QueueModule } from '@habit/api/queue';\nvoid WorkerModule;\nexport type Q = typeof QueueModule;\n",
    'apps/web/package.json': json({
      name: '@habit/web',
      dependencies: { '@habit/shared-types': 'workspace:*', '@habit/ui': 'workspace:*' },
    }),
    'apps/web/tsconfig.json':
      '{\n  // comments are fine\n  "compilerOptions": { "paths": { "@/*": ["./*"] } }\n}\n',
    'apps/web/app/page.tsx':
      "import { Button } from '@habit/ui';\nimport { a } from '@/lib/a';\nimport './globals.css';\nexport default function Page() { return Button() ?? a; }\n",
    'apps/web/app/globals.css': '@import "@habit/ui/styles.css";\n',
    'apps/web/lib/a.ts': "import { b } from '@/lib/b';\nexport const a = b;\n",
    'apps/web/lib/b.ts':
      "import type { Id } from '@habit/shared-types';\nexport const b: Id = 'b';\n",
    'apps/web/.next/server/chunk.js': "import '../../../api/src/main.js';\n",
    'apps/web/node_modules/x/index.js': "import '../../../../packages/ui/src/button.js';\n",
  };
}

/** @type {string[]} */
const created = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Write the baseline with `changes` applied (a `null` value deletes a file) and check it.
 * @param {Record<string, string | null>} [changes]
 */
const check = (changes = {}) =>
  checkArchitecture({ root: writeFixture(changes), rules }).violations;

/** @param {ReturnType<typeof check>} violations */
const ruleIds = (violations) => [...new Set(violations.map((v) => v.rule))].sort();

/**
 * @param {string} file
 * @param {(manifest: any) => void} edit
 */
function manifest(file, edit) {
  const value = JSON.parse(/** @type {string} */ (baseline()[file]));
  edit(value);
  return { [file]: json(value) };
}

describe('architecture rules — fixtures', () => {
  it('accepts the baseline (layers, module entries, composition root, aliases, app exception)', () => {
    expect(check()).toEqual([]);
  });

  describe('workspace graph (package.json)', () => {
    it('rejects a package depending on an app', () => {
      const violations = check(
        manifest('packages/localization/package.json', (m) => {
          m.dependencies = { '@habit/worker': 'workspace:*' };
        }),
      );
      expect(ruleIds(violations)).toEqual(['layer/package-depends-on-app']);
      expect(violations[0]).toMatchObject({ file: 'packages/localization/package.json' });
    });

    it('rejects an app depending on another app (web → api)', () => {
      const violations = check(
        manifest('apps/web/package.json', (m) => {
          m.dependencies['@habit/api'] = 'workspace:*';
        }),
      );
      expect(ruleIds(violations)).toEqual(['layer/app-depends-on-app']);
    });

    it('rejects an app depending on another app even when the graph lists it (api → web)', () => {
      const violations = checkArchitecture({
        root: writeFixture(
          manifest('apps/api/package.json', (m) => {
            m.dependencies['@habit/web'] = 'workspace:*';
          }),
        ),
        rules: {
          ...rules,
          allowedDependencies: {
            ...rules.allowedDependencies,
            '@habit/api': [...(rules.allowedDependencies['@habit/api'] ?? []), '@habit/web'],
          },
        },
      }).violations;
      expect(ruleIds(violations)).toEqual(['layer/app-depends-on-app']);
    });

    it('rejects an edge missing from the allowed graph', () => {
      const violations = check(
        manifest('packages/ui/package.json', (m) => {
          m.dependencies = { '@habit/shared-validation': 'workspace:*' };
        }),
      );
      expect(ruleIds(violations)).toEqual(['workspace/edge-not-allowed']);
    });

    it('rejects a workspace package with no allowed-graph entry', () => {
      const violations = check({
        'packages/new-thing/package.json': json({ name: '@habit/new-thing' }),
      });
      expect(ruleIds(violations)).toEqual(['workspace/unknown-package']);
    });

    it('rejects a dependency cycle between workspace packages', () => {
      const violations = check(
        manifest('packages/localization/package.json', (m) => {
          m.dependencies = { '@habit/shared-validation': 'workspace:*' };
        }),
      );
      expect(ruleIds(violations)).toEqual(['workspace/cycle', 'workspace/edge-not-allowed']);
      expect(violations.find((v) => v.rule === 'workspace/cycle')?.message).toMatch(
        /@habit\/localization → @habit\/shared-validation → @habit\/localization|@habit\/shared-validation → @habit\/localization → @habit\/shared-validation/,
      );
    });
  });

  describe('imports between workspace packages', () => {
    it('rejects importing a workspace package that is not declared', () => {
      const violations = check({
        'apps/web/lib/b.ts':
          "import { isLocale } from '@habit/shared-validation';\nexport const b = isLocale('en');\n",
      });
      expect(ruleIds(violations)).toEqual(['import/undeclared-dependency']);
      expect(violations[0]).toMatchObject({ file: 'apps/web/lib/b.ts', line: 1 });
    });

    it('rejects a package importing an app', () => {
      const violations = check({
        'packages/localization/src/index.ts': "import '@habit/web';\nexport const locales = [];\n",
      });
      expect(ruleIds(violations)).toEqual([
        'import/undeclared-dependency',
        'layer/package-depends-on-app',
      ]);
    });

    it('rejects the web app importing API internals', () => {
      const violations = check({
        'apps/web/lib/b.ts': "export { WorkerModule as b } from '@habit/api/worker';\n",
      });
      expect(ruleIds(violations)).toEqual([
        'import/undeclared-dependency',
        'layer/app-depends-on-app',
      ]);
    });

    it('limits the worker → API exception to the listed exports', () => {
      const violations = check({
        ...manifest('apps/api/package.json', (m) => {
          m.exports['./openapi'] = dist('openapi/index');
        }),
        'apps/worker/src/main.ts': "import '@habit/api/openapi';\n",
      });
      expect(ruleIds(violations)).toEqual(['layer/app-exception-subpath']);
    });

    it('rejects deep imports into package internals (src/, dist/, unexported paths)', () => {
      const violations = check({
        'apps/web/lib/b.ts':
          "import { Button } from '@habit/ui/src/button';\nimport '@habit/ui/dist/index.js';\nexport const b = Button;\n",
      });
      expect(ruleIds(violations)).toEqual(['import/deep-import']);
      expect(violations.map((v) => v.line)).toEqual([1, 2]);
    });

    it('rejects relative paths that leave the package', () => {
      const violations = check({
        'apps/web/lib/b.ts':
          "export { Button as b } from '../../../packages/ui/src/button.js';\nimport('../../api/src/main.js');\n",
      });
      expect(ruleIds(violations)).toEqual(['import/outside-package']);
      expect(violations).toHaveLength(2);
      expect(violations[0]?.message).toMatch(/depend on @habit\/ui/);
    });
  });

  describe('API module boundaries (ADR-0006)', () => {
    it('rejects importing another module’s internal file', () => {
      const violations = check({
        'apps/api/src/modules/goals/index.ts':
          "import { HabitsService } from '../habits/habits.service.js';\nexport const GoalsModule = HabitsService;\n",
      });
      expect(ruleIds(violations)).toEqual(['api/module-internal-import']);
    });

    it('rejects type-only imports of module internals too', () => {
      const violations = check({
        'apps/api/src/modules/goals/index.ts':
          "import type { HabitsService } from '../habits/habits.service.js';\nexport type GoalsModule = HabitsService;\n",
      });
      expect(ruleIds(violations)).toEqual(['api/module-internal-import']);
    });

    it('rejects module internals imported from the composition root', () => {
      const violations = check({
        'apps/api/src/app.module.ts':
          "import { HabitsService } from './modules/habits/habits.service.js';\nexport const AppModule = [HabitsService];\n",
      });
      expect(ruleIds(violations)).toEqual(['api/module-internal-import']);
    });

    it('rejects a platform area depending on a feature module', () => {
      const violations = check({
        'apps/api/src/queue/index.ts':
          "import { HabitsModule } from '../modules/habits/index.js';\nexport const QueueModule = HabitsModule;\n",
      });
      expect(ruleIds(violations)).toEqual(['api/platform-imports-module']);
    });

    it('rejects the generated Prisma client outside database/ and modules/', () => {
      const violations = check({
        'apps/api/src/queue/index.ts':
          "import { PrismaClient } from '../generated/prisma/client.js';\nexport const QueueModule = PrismaClient;\n",
      });
      expect(ruleIds(violations)).toEqual(['api/generated-client-import']);
    });

    it('rejects cycles between API areas, even through type-only imports', () => {
      const violations = check({
        'apps/api/src/database/index.ts':
          "import type { QueueModule } from '../queue/index.js';\nimport { PrismaClient } from '../generated/prisma/client.js';\nexport const DatabaseModule = new PrismaClient();\nexport type Q = typeof QueueModule;\n",
      });
      expect(ruleIds(violations)).toEqual(['api/area-cycle']);
      expect(violations[0]?.message).toMatch(
        /(database → queue → database|queue → database → queue)/,
      );
    });

    it('rejects a feature module without index.ts', () => {
      const violations = check({
        'apps/api/src/modules/tasks/tasks.service.ts': 'export class TasksService {}\n',
      });
      expect(ruleIds(violations)).toEqual(['api/module-missing-entry']);
    });
  });

  describe('cycles in source', () => {
    it('rejects a runtime import cycle between files', () => {
      const violations = check({
        'apps/web/lib/b.ts': "import { a } from '@/lib/a';\nexport const b = () => a;\n",
      });
      expect(ruleIds(violations)).toEqual(['cycle/file']);
      expect(violations[0]?.message).toMatch(/lib\/(a|b)\.ts → lib\/(a|b)\.ts → lib\/(a|b)\.ts/);
    });

    it('allows a cycle made only of type imports (erased at runtime)', () => {
      expect(
        check({
          'apps/web/lib/b.ts':
            "import type { a } from '@/lib/a';\nexport const b = 'b';\nexport type A = typeof a;\n",
        }),
      ).toEqual([]);
    });
  });
});

describe('helpers', () => {
  it('finds strongly connected components and self-loops', () => {
    const graph = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set(['d'])],
      ['e', new Set(['a'])],
    ]);
    expect(findCycles(graph).map((c) => c.sort())).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('reads every import form and marks type-only ones', () => {
    const file = writeFixture(
      {
        'x.ts': [
          "import a from 'a';",
          "import type { B } from 'b';",
          "import { type C } from 'c';",
          "import { type D, d } from 'd';",
          "export * from 'e';",
          "export type { F } from 'f';",
          "import g = require('g');",
          "const h = await import('h');",
          "const i = require('i');",
          "type J = typeof import('j');",
          "import 'k';",
        ].join('\n'),
      },
      false,
    );
    const refs = extractImports(path.join(file, 'x.ts'));
    expect(refs.map((r) => [r.specifier, r.typeOnly])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
      ['d', false],
      ['e', false],
      ['f', true],
      ['g', false],
      ['h', false],
      ['i', false],
      ['j', true],
      ['k', false],
    ]);
  });
});

describe('this repository', () => {
  it('satisfies every architecture rule', () => {
    const result = checkArchitecture({ root: REPOSITORY_ROOT, rules });
    expect(result.violations).toEqual([]);
    expect(result.packages).toBeGreaterThanOrEqual(8);
  });
});

/**
 * Write the baseline (unless `withBaseline` is false) with `files` applied into a fresh temp
 * directory; a `null` value removes a baseline file.
 * @param {Record<string, string | null>} files
 * @param {boolean} [withBaseline]
 */
function writeFixture(files, withBaseline = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-fixture-'));
  created.push(root);
  for (const [file, content] of Object.entries({ ...(withBaseline ? baseline() : {}), ...files })) {
    if (content === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}
