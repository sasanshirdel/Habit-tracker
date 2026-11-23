import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Unit + HTTP (supertest) tests. They must not need a running database: DATABASE_URL points at
// a closed local port, so readiness is exercised in its "database down" state. Tests that need a
// real PostgreSQL are `*.int.test.ts` and run via `pnpm test:integration`.
// SWC is used so NestJS decorator metadata (emitDecoratorMetadata) is emitted in tests.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**'],
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unreachable:unreachable@127.0.0.1:1/unreachable',
    },
  },
});
