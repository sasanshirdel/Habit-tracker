import { defineConfig, devices } from '@playwright/test';
import {
  E2E_API_BASE_URL,
  E2E_API_ORIGIN,
  E2E_API_PORT,
  E2E_OUTBOX_DIR,
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
 * A fresh rate-limit namespace per run (P2-09), so counters of a previous run never count against
 * this one. Since P2-04 every test also presents its own client address to the API (see
 * `TRUST_PROXY` below and `clientAddressFor` in e2e/browser/env.ts), so the `auth` class
 * (10 per 5 minutes per address, unchanged) budgets each test separately instead of the whole
 * suite. Computed once here, in the runner process that starts the API.
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
        // One trusted hop: the client address comes from X-Forwarded-For, which the suite sets per
        // test on API requests (P2-04) — as a load balancer would. Never more than the real hops.
        TRUST_PROXY: '1',
        QUEUE_PREFIX: E2E_QUEUE_PREFIX,
        LOG_LEVEL: 'warn',
      },
    },
    {
      // Sends the emails the API queues (P2-04): the built worker on the same Redis queues, with
      // the file outbox instead of a mail server, so tests can open the links (ADR-0021).
      name: 'worker',
      command: 'node dist/main.js',
      cwd: '../worker',
      wait: { stdout: /Consuming queue \\?"email/ },
      reuseExistingServer: !isCI,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: requireEnv('DATABASE_URL'),
        REDIS_URL: requireEnv('REDIS_URL'),
        QUEUE_PREFIX: E2E_QUEUE_PREFIX,
        MAIL_TRANSPORT: 'outbox',
        MAIL_OUTBOX_DIR: E2E_OUTBOX_DIR,
        WEB_APP_URL: E2E_WEB_ORIGIN,
        LOG_LEVEL: 'info',
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
