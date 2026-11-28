import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test as setup, expect } from '@playwright/test';
import { E2E_API_BASE_URL, SHARED_ACCOUNT, STORAGE_STATE, clientAddressFor } from './env';
import { presentClientAddress, verificationLinkIn, waitForEmails } from './fixtures';

/**
 * Signs one account in for the whole suite (P2-09): the pages of the signed-in app need a
 * session, and signing in per test would cost time and `auth` budget. Since P2-04 the account is
 * also verified through its emailed link (from the worker's outbox), so the shared state is an
 * ordinary verified user without the verification banner. Uses the API directly from the web
 * origin (as the app does, cross-origin with credentials); the UI journeys are covered by
 * `auth.spec.ts` and `verify-email.spec.ts`.
 */
setup('sign in the shared account', async ({ page }, testInfo) => {
  await presentClientAddress(page.context(), clientAddressFor(testInfo.testId));
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
      return post('/auth/register', { email, password, locale: 'en', timezone: 'UTC' });
    },
    { api: E2E_API_BASE_URL, email, password },
  );
  expect(statuses).toBe(202);

  const [message] = await waitForEmails(email);
  const token = new URL(verificationLinkIn(message!)).hash.replace('#token=', '');
  const signedIn = await page.evaluate(
    async ({ api, email, password, token }) => {
      const post = (path: string, body: unknown) =>
        fetch(`${api}${path}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        });
      const confirm = (await post('/auth/verification/confirm', { token })).status;
      const login = await post('/auth/login', { email, password });
      const body = (await login.json()) as { user?: { emailVerified?: boolean } };
      return { confirm, login: login.status, verified: body.user?.emailVerified };
    },
    { api: E2E_API_BASE_URL, email, password, token },
  );
  expect(signedIn).toEqual({ confirm: 200, login: 200, verified: true });
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE });
  // Only the address: tests use it for a wrong-password attempt. Test-only, gitignored.
  writeFileSync(SHARED_ACCOUNT, JSON.stringify({ email }));
});
