# ADR-0015: Browser end-to-end tests with Playwright

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

ADR-0007 named Playwright for end-to-end tests, to arrive in Phase 1 with a smoke test. Backlog
P1-13 (#17) introduces it. Several earlier issues deferred browser-only checks to it:

- P1-08 (#12): the Content-Security-Policy is proven by unit and HTTP tests, but only a browser
  shows that the app's own scripts run under it, that injected ones are blocked and that the UI
  primitives (Radix Dialog's scroll lock, menus, toasts) inject nothing outside the policy.
- P1-10 (#14): a "Playwright check of dir/lang".
- P1-11 (#15): the shell at 3 viewports × 2 locales (which navigation shows, sidebar at the inline
  start) and the keyboard journey (skip link, the "More" sheet's focus trap and focus return).
- P1-12 (#16): the `/status` demo calls the API from the browser — cross-origin, with credentials.

The HTTP route tests (`test:e2e`, Vitest against `next start`, P1-10) stay: they are cheap, need no
browser or services and check the server's responses exactly.

## Decision

- **`@playwright/test` 1.65.1** (dev dependency of `apps/web`; ADR-0001 addendum). Config:
  `apps/web/playwright.config.ts`; tests: `apps/web/e2e/browser/*.spec.ts` (`pnpm --filter
@habit/web test:browser`). The Vitest configs never pick these files up (`*.spec.ts` under
  `e2e/browser/`, the route tests are `e2e/*.e2e.test.ts`).
- **What runs:** the production builds only — the web app under `next start` and the API as
  `node dist/main.js` (`NODE_ENV=production`) on real PostgreSQL and Redis. Playwright's `webServer`
  starts both and waits for `GET /api/v1/health/ready` (so the database and Redis are up) and for
  `/en`. No mocks of our own API in the browser suite.
- **Topology:** fixed loopback ports, web `http://127.0.0.1:3100`, API `http://127.0.0.1:4100`
  (`e2e/browser/env.ts`). The browser reaches the API **cross-origin**, like a deployment with a
  separate API host, so CORS with credentials (`CORS_ORIGINS` = the web origin) and the CSP's
  `connect-src` for the API origin are exercised for real. Because `NEXT_PUBLIC_API_BASE_URL` is
  inlined at build time, the suite needs its own build: `pnpm --filter @habit/web build:e2e`. A
  global setup refuses to run against a build that does not carry the suite's API address. The API
  uses its own Redis namespaces (`habit:e2e:rl`, `habit:e2e:q`).
- **Browser:** **Chromium only** for now — Playwright 1.65.1's Chrome Headless Shell 159.0.8154.6
  (revision 1255), installed with `playwright install --only-shell chromium`. Firefox and WebKit
  (Safari matters for iOS PWA users) are added with the critical-journey coverage in P12-01, or
  earlier when a feature depends on engine behaviour.
- **A guard on every page** (`e2e/browser/fixtures.ts`, automatic fixture): a listener installed
  before any page script (DevTools-protocol init script, which the page's CSP does not cover)
  records every `securitypolicyviolation`; after each test the page must have produced **no CSP
  violation, no `console.error` and no uncaught error**. Tests that provoke violations on purpose
  opt out (`allowPageErrors`) and assert on the violations they expect.
- **Determinism:** fixed viewports (phone 390×844, tablet 820×1180, desktop 1366×768), `timezoneId`
  UTC, light colour scheme, locale per test from the URL (or the browser locale where negotiation is
  under test); assertions use the app's message catalogues rather than copied strings; no sleeps
  (web-first assertions and `expect.poll`); **no retries** — a flaky test is a bug, and every failure
  keeps a trace and a screenshot. Checked with `--repeat-each=3` on 2 workers.
- **CI:** an `e2e` job beside `verify` and `integration`, with the same throwaway PostgreSQL/Redis
  service containers (no secrets): install, `build:deps`, `build:e2e`, `prisma migrate deploy`,
  browsers from an `actions/cache` keyed on OS, architecture and Playwright version (OS libraries
  are installed every run with `install-deps`, since they cannot be cached), `test:browser`. On
  failure the HTML report and `test-results/` (traces, screenshots) are uploaded as the
  `playwright-report` artifact (14 days).

## Alternatives considered

- **Same-origin through a test reverse proxy** (`/api` → API, ADR-0014's other topology): reuses
  the ordinary build, but skips the CORS and `connect-src` paths a split deployment depends on.
  Cross-origin is the stricter of the two; same-origin can be added if a deployment uses it.
- **Mocking the API with `page.route`:** fast, but the point of the smoke is the real stack.
  Error states stay covered by the component tests (P1-12).
- **Retries in CI (`retries: 2`):** hides flakiness; traces on failure make a red run actionable.
- **Cypress / WebdriverIO:** Playwright is what ADR-0007 and the PRD name; it drives Chromium,
  Firefox and WebKit from one API and ships a trace viewer.
- **Caching the browsers' OS dependencies (apt):** fragile across runner image updates.

## Consequences

- `pnpm --filter @habit/web test:browser` needs PostgreSQL, Redis (`DATABASE_URL`, `REDIS_URL`), the
  built API (`pnpm build:deps`), the `build:e2e` web build and a Chromium from
  `pnpm --filter @habit/web exec playwright install --only-shell chromium` (Linux may also need
  `--with-deps`). Locally, an already running web or API on the suite's ports is reused.
- In an environment with an HTTP proxy, set `NO_PROXY=127.0.0.1,localhost`, or Playwright's
  readiness checks go to the proxy.
- Since P2-09 (ADR-0020): a `setup` project signs a shared account in (`storageState`); tests
  that sign in/out start signed out with their own account; each run uses its own rate-limit
  prefix and the suite stays within `E2E_AUTH_BUDGET` sign-ups/sign-ins (the `auth` limit is not
  switched off); signed-out pages may declare Chromium's 401 console message as expected.
- Since P2-04 (ADR-0021): the suite also starts the built worker (`MAIL_TRANSPORT=outbox`, links
  read from `apps/web/e2e/.outbox`), and `E2E_AUTH_BUDGET` is replaced by **per-test client
  addresses**: the API trusts one proxy hop and each test's context sends its own
  `X-Forwarded-For` on API requests, so the unchanged `auth` limit budgets each test separately.
- The suite grows per phase toward the 15 PRD journeys (P12-01). New pages get the guard for free;
  a page that legitimately logs an error must fix it rather than opt out.
