import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests against a real PostgreSQL (ADR-0007). Requires DATABASE_URL for a role that
// may CREATE DATABASE (local docker-compose user, or the CI service container). The global setup
// creates a throwaway database, applies migrations with `prisma migrate deploy`, and drops it
// afterwards, so the database in DATABASE_URL itself is never modified.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/integration/global-setup.ts'],
    // One isolated database is shared by the run, so files run sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test' },
  },
});
