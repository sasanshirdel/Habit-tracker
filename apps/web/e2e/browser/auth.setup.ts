import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { E2E_API_BASE_URL, SHARED_ACCOUNT, STORAGE_STATE } from './env';

/**
 * Signs one account in for the whole suite (P2-09): the pages of the signed-in app now need a
 * session, and a sign-in per test would exhaust the API's `auth` rate limit (see
 * `E2E_AUTH_BUDGET`). Uses the API directly from the web origin (as the app does, cross-origin
 * with credentials); the sign-up/sign-in UI itself is covered by `auth.spec.ts`.
 */
setup('sign in the shared account', async ({ page }) => {
  const email = `browser.shared.${Date.now()}@example.test`;
  const password = 'shared account pass phrase';
  await page.goto('/en/status');
  const statuses = await page.evaluate(
    async ({ api, email, password }) => {
      const post = (path: string, body: unknown) =>
        fetch(`${api}${path}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }).then((res) => res.status);
      return {
        register: await post('/auth/register', { email, password, locale: 'en', timezone: 'UTC' }),
        login: await post('/auth/login', { email, password }),
      };
    },
    { api: E2E_API_BASE_URL, email, password },
  );
  expect(statuses).toEqual({ register: 202, login: 200 });
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE });
  // Only the address: tests use it for a wrong-password attempt. Test-only, gitignored.
  writeFileSync(SHARED_ACCOUNT, JSON.stringify({ email }));
});
