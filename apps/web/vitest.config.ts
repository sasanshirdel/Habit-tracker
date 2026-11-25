import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The app's `@/…` imports (tsconfig `paths`).
  resolve: { alias: [{ find: /^@\//, replacement: `${import.meta.dirname}/` }] },
  test: {
    include: ['**/*.test.{ts,tsx}'],
    // e2e/ runs against `next start`: `pnpm test:e2e` (vitest.e2e.config.ts).
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    // Component tests opt in per file with `// @vitest-environment jsdom`.
    environment: 'node',
    // next-intl's ESM imports `next/server` without an extension; let Vite resolve it.
    server: { deps: { inline: ['next-intl'] } },
  },
});
