// @ts-check
/**
 * The repository's architecture rules (backlog P1-15, ADR-0016), checked by `check.js`.
 *
 * This file is the single, reviewable source of the allowed dependency graph. Changing it changes
 * the architecture: update docs/ARCHITECTURE.md §2.1 in the same pull request.
 *
 * @typedef {import('./check.js').ArchitectureRules} ArchitectureRules
 */

/** @type {ArchitectureRules} */
const rules = {
  /** Workspace directories by layer. Apps may depend on packages; packages never on apps. */
  layers: { app: 'apps/', package: 'packages/' },

  /** Build and lint tooling every workspace package may use (dev dependency). */
  tooling: ['@habit/config'],

  /**
   * Every allowed edge between workspace packages (package.json dependencies of any kind and the
   * imports in source). An edge not listed here fails, and so does a workspace package with no
   * entry. Layer rules apply on top: listing `packages/* → apps/*` here does not make it legal.
   */
  allowedDependencies: {
    '@habit/config': [],
    '@habit/shared-types': [],
    '@habit/localization': [],
    '@habit/shared-validation': ['@habit/localization'],
    /** Pure habit logic (ADR-0029): contract types and calendar settings only, no zod, no I/O. */
    '@habit/habit-engine': ['@habit/shared-types', '@habit/localization'],
    '@habit/ui': [],
    /** The API uses the habit engine at runtime since P3-03 (ADR-0030: today, version checks). */
    '@habit/api': [
      '@habit/shared-types',
      '@habit/shared-validation',
      '@habit/localization',
      '@habit/habit-engine',
    ],
    '@habit/worker': [
      '@habit/api',
      '@habit/shared-types',
      '@habit/shared-validation',
      '@habit/localization',
    ],
    '@habit/web': [
      '@habit/shared-types',
      '@habit/shared-validation',
      '@habit/localization',
      '@habit/habit-engine',
      '@habit/ui',
    ],
  },

  /**
   * The only app → app edges. The worker process runs the API's queue and worker modules
   * (ADR-0002 addendum P1-03) and may import exactly these package exports of `@habit/api`.
   */
  appExceptions: [
    {
      from: '@habit/worker',
      to: '@habit/api',
      subpaths: ['./queue', './worker'],
      reason: 'the worker runs the API queue/worker modules (ADR-0002, P1-03)',
    },
  ],

  /** Internal layering of the modular-monolith API (ADR-0006). */
  api: {
    package: '@habit/api',
    srcDir: 'src',
    /** Feature modules: `src/modules/<name>/`, public surface `index.ts`. */
    modulesDir: 'modules',
    /** Platform areas that compose feature modules (besides the files directly in `src/`). */
    compositionAreas: ['worker'],
    /** Prisma's generated client, and the source areas allowed to import it. */
    generatedDir: 'generated',
    generatedImporters: ['database', 'modules'],
  },
};

export default rules;
