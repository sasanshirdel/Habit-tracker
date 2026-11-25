import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    // e2e/ runs against `next start`: `pnpm test:e2e` (vitest.e2e.config.ts).
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    environment: 'node',
    // next-intl's ESM imports `next/server` without an extension; let Vite resolve it.
    server: { deps: { inline: ['next-intl'] } },
  },
});
