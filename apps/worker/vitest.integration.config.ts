import { defineConfig } from 'vitest/config';

// Integration tests: spawn the built worker (`dist/main.js`) as a real process against a real Redis
// (REDIS_URL) and PostgreSQL (DATABASE_URL, only connected to — never modified). Queue keys use a
// per-run prefix under `habit:it:` that the tests delete afterwards.
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test' },
  },
});
