import { defineConfig } from 'vitest/config';

// Unit tests: no Redis, no database, no built API needed.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
