import { defineConfig } from 'vitest/config';

/**
 * Route tests against the production build (`next build` first): a real `next start` serves
 * `/`, `/fa`, `/en` and a 404 through `proxy.ts`, and the tests read the HTTP responses —
 * status, redirects, `<html lang dir>`, CSP nonces on scripts, cookies (backlog P1-10). The
 * browser-driven Playwright suite arrives with P1-13.
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    globalSetup: ['e2e/start-server.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
