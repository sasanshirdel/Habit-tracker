import { defineConfig, devices } from '@playwright/test';
import {
  E2E_API_BASE_URL,
  E2E_API_ORIGIN,
  E2E_API_PORT,
  E2E_QUEUE_PREFIX,
  E2E_RATE_LIMIT_PREFIX,
  E2E_WEB_ORIGIN,
  E2E_WEB_PORT,
  STORAGE_STATE,
} from './e2e/browser/env';

/**
 * Browser end-to-end suite (backlog P1-13, ADR-0007, ADR-0015): real Chromium against the
 * production build under `next start` and the built API (`node dist/main.js`) on PostgreSQL and
 * Redis. Run `pnpm --filter @habit/web build:e2e` first (the web build must point the browser at
 * the API below), with DATABASE_URL and REDIS_URL set — see apps/web/README.md.
 *
 * The HTTP route tests (`test:e2e`, Vitest) stay; this suite covers what only a browser can show:
 * CSP enforcement, layout per viewport, focus and keyboard behaviour, client-side data fetching.
 */
const isCI = !!process.env.CI;

/**
 * A fresh rate-limit namespace per run (P2-09): the suite's sign-ups and sign-ins all come from
 * 127.0.0.1 and the `auth` class allows 10 per 5 minutes, so counters from a previous run must
 * not count against this one (`E2E_AUTH_BUDGET` in e2e/browser/env.ts). Computed once here, in
 * the runner process that starts the API.
 */
const rateLimitPrefix = `${E2E_RATE_LIMIT_PREFIX}:${Date.now().toString(36)}`;

function requireEnv(name: 'DATABASE_URL' | 'REDIS_URL'): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: the browser suite starts the real API, which needs PostgreSQL and Redis (see apps/web/README.md).`,
    );
  }
  return value;
}

export default defineConfig({
  testDir: './e2e/browser',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/browser/global-setup.ts',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  // No retries: a flaky test is a bug to fix, not to hide. Traces are kept for every failure.
  retries: 0,
  workers: isCI ? 2 : undefined,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: isCI
    ? [['list'], ['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: E2E_WEB_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Deterministic rendering: one timezone and colour scheme everywhere; each test sets the
    // locale it needs through the URL (or Accept-Language where negotiation is under test).
    timezoneId: 'UTC',
    colorScheme: 'light',
  },
  projects: [
    // Signs the shared account in once and saves the browser state (P2-09).
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium',
      dependencies: ['setup'],
      // Signed in by default; tests about signing in/out opt out with `SIGNED_OUT`.
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
    },
  ],
  webServer: [
    {
      name: 'api',
      command: 'node dist/main.js',
      cwd: '../api',
      url: `${E2E_API_BASE_URL}/health/ready`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      env: {
        NODE_ENV: 'production',
        API_PORT: String(E2E_API_PORT),
        CORS_ORIGINS: E2E_WEB_ORIGIN,
        DATABASE_URL: requireEnv('DATABASE_URL'),
        REDIS_URL: requireEnv('REDIS_URL'),
        RATE_LIMIT_PREFIX: rateLimitPrefix,
        QUEUE_PREFIX: E2E_QUEUE_PREFIX,
        LOG_LEVEL: 'warn',
      },
    },
    {
      name: 'web',
      command: `node node_modules/next/dist/bin/next start -p ${E2E_WEB_PORT} -H 127.0.0.1`,
      url: `${E2E_WEB_ORIGIN}/en`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      env: { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
  metadata: { api: E2E_API_ORIGIN },
});
