# ADR-0016: Architecture boundary check

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

ADR-0006 promised "an architecture test (backlog item, Phase 1)" for the API's module boundaries,
and ADR-0002 states the workspace rules in prose: packages never import apps, consumers use a
package's `exports` (its built `dist/`), never its `src/`, and `apps/worker` is the one app that
depends on another app (`@habit/api/queue`, `@habit/api/worker`). Nothing checked any of this.
`pnpm`'s strict `node_modules` catches some undeclared imports, but not relative paths into another
package, not a dependency that is declared but should not exist (`apps/web` → `@habit/api`), and not
the API's internal layering. Backlog P1-15 (#19): a violating import must fail lint and CI.

The API has no feature modules yet (`src/modules/` arrives with Phase 2), so the rules for them must
be proven on fixtures, not only on the current tree.

## Decision

An in-repo check, `packages/config/architecture/` (`check.js`, `rules.js`, `cli.js`), with **no new
dependency**: it parses every source file with the TypeScript compiler's parser (`typescript`
6.0.3, already pinned and already `@habit/config`'s peer) and resolves specifiers itself, the way
this repository resolves them (`.js` → `.ts` for NodeNext, extensionless and `index` files for the
bundler, the package's own `tsconfig` `paths` such as `@/*`, and `package.json#exports` for
`@habit/*`). `@habit/config` gains `lint`, `typecheck` (`checkJs`) and `test` scripts and declares the
tools it already used as pinned dev dependencies (`typescript` 6.0.3, `eslint` 10.15.0, `vitest`
5.1.1, `@types/node` 24.19.2 — versions already in the lockfile).

**Where it runs:** root `pnpm lint` = per-package ESLint, then `pnpm check:architecture` (`node
packages/config/architecture/cli.js`; about a second, no build needed). CI's existing `verify` job
runs `pnpm lint`, so no new job. `pnpm test` also runs the rule fixtures and a "this repository
passes" test (`packages/config/architecture/check.test.js`).

**What it reads:** all `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs` files of every workspace package
(source, tests, configs, e2e), skipping `node_modules`, `dist`, dot-directories (`.next`), reports
and `generated/` (generated code is only an import target). Every import form counts: static and
dynamic `import`, `export … from`, `require`, `import x = require()`, `import('x')` types.

**Rules** (ids as printed):

| Rule                           | Fails when                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer/package-depends-on-app` | a `packages/*` package depends on or imports an `apps/*` package                                                                                                     |
| `layer/app-depends-on-app`     | an app depends on or imports another app, except edges in `appExceptions` (only worker → api)                                                                        |
| `layer/app-exception-subpath`  | the worker imports an `@habit/api` entry other than `./queue` and `./worker`                                                                                         |
| `workspace/edge-not-allowed`   | a workspace dependency or import is not in the allowed graph (`rules.js` `allowedDependencies`, ARCHITECTURE §2.1); `@habit/config` is tooling, allowed everywhere   |
| `workspace/unknown-package`    | a workspace package has no entry in the allowed graph                                                                                                                |
| `workspace/cycle`              | workspace packages depend on each other in a cycle                                                                                                                   |
| `import/undeclared-dependency` | a file imports a `@habit/*` package its `package.json` does not declare                                                                                              |
| `import/deep-import`           | an `@habit/*` import names a subpath the package's `exports` does not publish (`@habit/ui/src/…`, `…/dist/…`)                                                        |
| `import/outside-package`       | a relative or alias import resolves outside the importing package                                                                                                    |
| `api/module-internal-import`   | code in `src/` outside `src/modules/<name>/` imports anything there but its `index.ts` (type-only imports included)                                                  |
| `api/platform-imports-module`  | a platform area (`common`, `config`, `database`, `queue`, `rate-limit`, `openapi`, `health`, …) imports a feature module; only `src/*.ts` and `worker/` compose them |
| `api/generated-client-import`  | `src/generated` (Prisma client) is imported from `src/` outside `database/` and `modules/` (tests outside `src/` may)                                                |
| `api/module-missing-entry`     | a directory in `src/modules/` has no `index.ts`                                                                                                                      |
| `api/area-cycle`               | API areas (`src/<area>`, each `modules/<name>`) depend on each other in a cycle — type imports count, test files and the `src/*.ts` composition root do not          |
| `cycle/file`                   | files of one package import each other in a runtime cycle (type-only imports are erased and ignored)                                                                 |

Platform areas may import each other's files directly (they are one shared kernel and already do);
only feature modules get the "public `index.ts` only" rule from ADR-0006.

**Proof:** `check.test.js` writes a miniature workspace that passes under the real `rules.js` and
breaks each rule in turn (25 tests). Each rule was also broken once in the real tree and the check
failed with that rule id (recorded in PR for #19).

## Alternatives considered

- **dependency-cruiser 18.9.0** (checked 2026-11-25 with `npm view`): covers graph rules, cycles and
  path rules well, but adds 18 direct dependencies and its own resolver configuration for three
  module-resolution styles; the API layering rules here would still be custom regular expressions.
- **eslint-plugin-boundaries 7.4.4** / **eslint-plugin-import-x 4.18.1** `no-cycle`: per-file lint
  rules that need an import resolver plugin (one more dependency) and type-aware or per-file cycle
  detection (slow on the whole repo); neither checks `package.json` dependency edges.
- **ESLint core `no-restricted-imports`:** matches specifier text only; it cannot tell which module
  a file belongs to, follow `@/` aliases or detect cycles.
- **A new workspace package (`tools/architecture`):** cleaner separation, but a new top-level
  workspace directory for one script; `@habit/config` already holds the repository's lint and
  compiler configuration.

## Consequences

- Adding a workspace package or a dependency between workspace packages means editing
  `packages/config/architecture/rules.js` and ARCHITECTURE §2.1 in the same PR — deliberate, and
  visible in review.
- The checker uses `ts.createSourceFile` from the TypeScript 6 JavaScript API. When the repository
  moves to the native TypeScript 7 compiler (ADR-0001 risk), the parser call has to be revisited.
- Not covered yet (follow-ups, not in #19): table ownership per module (needs product models,
  Phase 2+); ADR-0009's "no handler parameter without a pipe" (a decorator-level rule, better as
  a test over Nest route metadata like the OpenAPI generator's); `apps/admin` (Phase 10) needs a
  graph entry when it is created.
