import type { Page } from '@playwright/test';
import { E2E_API_BASE_URL, SIGNED_OUT, clientAddressFor, directionOf, viewports } from './env';
import {
  UNAUTHENTICATED_CONSOLE_ERROR,
  expect,
  messages,
  outboxFor,
  passwordResetLinkIn,
  presentClientAddress,
  test,
  waitForTemplate,
} from './fixtures';

/**
 * Password recovery in a real browser against the real API and worker (backlog P2-05,
 * ADR-0022): "Forgot your password?" on the sign-in page → request → the emailed link (from the
 * worker's file outbox) → new password → every other session of the account is gone → sign in
 * with the new password. English (LTR, desktop) and Persian (RTL, phone).
 *
 * Expected console errors: the signed-out session check (401), and the 400/401 of requests that
 * fail on purpose (dead link, old password).
 */
const EXPECTED_CONSOLE_ERRORS = new RegExp(
  UNAUTHENTICATED_CONSOLE_ERROR.source.replace('401', '(?:400|401)'),
);
test.use({ storageState: SIGNED_OUT, expectedConsoleErrors: [EXPECTED_CONSOLE_ERRORS] });

type AuthMessages = Record<string, Record<string, string>>;
const auth = (locale: 'en' | 'fa') => messages(locale).auth as unknown as AuthMessages;

const uniqueEmail = (tag: string) =>
  `browser.reset.${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;

/** Registers through the API from the page's origin (the sign-up form is covered elsewhere). */
async function registerViaApi(page: Page, email: string, password: string, locale: 'en' | 'fa') {
  await page.goto(`/${locale}/auth/sign-in`);
  const status = await page.evaluate(
    async ({ api, email, password, locale }) =>
      (
        await fetch(`${api}/auth/register`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, locale, timezone: 'Asia/Tehran' }),
        })
      ).status,
    { api: E2E_API_BASE_URL, email, password, locale },
  );
  expect(status).toBe(202);
}

async function fillSignIn(page: Page, locale: 'en' | 'fa', email: string, password: string) {
  const t = auth(locale);
  await page.getByLabel(t.fields!.email!).fill(email);
  await page.getByLabel(t.fields!.password!, { exact: true }).fill(password);
  await page.getByRole('button', { name: t.signIn!.submit! }).click();
}

test('desktop · /en: forgot password → emailed link → new password → other devices signed out → sign in with the new password', async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize(viewports.desktop);
  const t = auth('en');
  const email = uniqueEmail('en');
  const oldPassword = 'the old pass phrase 2026';
  const newPassword = 'a fresh pass phrase 2026';
  await registerViaApi(page, email, oldPassword, 'en');

  // Another device is signed in to the account.
  const laptop = await browser.newContext({ storageState: SIGNED_OUT });
  await presentClientAddress(laptop, clientAddressFor(testInfo.testId));
  const other = await laptop.newPage();
  await other.goto('/en/auth/sign-in');
  await fillSignIn(other, 'en', email, oldPassword);
  await expect(other).toHaveURL('/en/overview');

  // Sign-in page → "Forgot your password?" → request.
  await page.goto('/en/auth/sign-in');
  await page.getByRole('link', { name: t.signIn!.forgotPassword! }).click();
  await expect(page).toHaveURL('/en/auth/forgot-password');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.forgotPassword!.title!);
  await page.getByLabel(t.fields!.email!).fill(email.toUpperCase());
  const requested = page.waitForResponse(`${E2E_API_BASE_URL}/auth/password-reset/request`);
  await page.getByRole('button', { name: t.forgotPassword!.submit! }).click();
  expect((await requested).status()).toBe(202);
  await expect(page.getByRole('heading', { name: t.forgotPassword!.sentTitle! })).toBeFocused();
  await expect(page.locator('[data-auth-step="reset-requested"]')).toContainText(email);

  const message = await waitForTemplate(email, 'identity.password-reset');
  expect(message.locale).toBe('en');
  const link = passwordResetLinkIn(message);

  // Opening the link changes nothing by itself and drops the token from the address bar.
  let confirms = 0;
  page.on('request', (request) => {
    if (request.url() === `${E2E_API_BASE_URL}/auth/password-reset/confirm`) confirms++;
  });
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.resetPassword!.title!);
  const submit = page.getByRole('button', { name: t.resetPassword!.submit! });
  await expect(submit).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(confirms).toBe(0);

  // Mismatch is caught in the browser.
  await page.getByLabel(t.fields!.newPassword!, { exact: true }).fill(newPassword);
  await page.getByLabel(t.fields!.confirmPassword!, { exact: true }).fill('something else');
  await submit.click();
  await expect(page.getByText(t.validation!.passwordsDontMatch!)).toBeVisible();
  expect(confirms).toBe(0);

  await page.getByLabel(t.fields!.confirmPassword!, { exact: true }).fill(newPassword);
  const reset = page.waitForResponse(`${E2E_API_BASE_URL}/auth/password-reset/confirm`);
  await submit.click();
  expect((await reset).status()).toBe(200);
  await expect(page.getByRole('heading', { name: t.resetPassword!.doneTitle! })).toBeFocused();
  const notice = await waitForTemplate(email, 'identity.password-changed');
  expect(notice.locale).toBe('en');

  // The other device's session has ended.
  await other.goto('/en/habits');
  await expect(other).toHaveURL('/en/auth/sign-in?next=%2Fhabits');
  await laptop.close();

  // The old password no longer works; the new one does.
  await page.getByRole('link', { name: t.resetPassword!.signIn! }).click();
  await expect(page).toHaveURL('/en/auth/sign-in');
  await fillSignIn(page, 'en', email, oldPassword);
  await expect(page.getByRole('alert')).toHaveText(t.errors!.invalidCredentials!);
  await fillSignIn(page, 'en', email, newPassword);
  await expect(page).toHaveURL('/en/overview');
  // Resetting proved the address: no verification reminder.
  await expect(page.locator('[data-verify-banner]')).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    'nothing in web storage',
  ).toBe(0);
});

test('phone · /fa: an unknown address gets the same confirmation (RTL); a dead link explains what to do', async ({
  page,
}) => {
  await page.setViewportSize(viewports.phone);
  const t = auth('fa');
  const unknown = uniqueEmail('fa.unknown');

  await page.goto('/fa/auth/forgot-password');
  await expect(page.locator('html')).toHaveAttribute('dir', directionOf.fa);
  await page.getByLabel(t.fields!.email!).fill(unknown);
  const requested = page.waitForResponse(`${E2E_API_BASE_URL}/auth/password-reset/request`);
  await page.getByRole('button', { name: t.forgotPassword!.submit! }).click();
  expect((await requested).status()).toBe(202);
  await expect(page.getByRole('heading', { name: t.forgotPassword!.sentTitle! })).toBeFocused();
  await expect(page.locator('[data-auth-step="reset-requested"]')).toContainText(unknown);
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

  // A well-formed link that the server does not know.
  await page.goto(`/fa/auth/reset-password#token=${'A'.repeat(43)}`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByLabel(t.fields!.newPassword!, { exact: true }).fill('یک عبارت عبور تازه و بلند');
  await page
    .getByLabel(t.fields!.confirmPassword!, { exact: true })
    .fill('یک عبارت عبور تازه و بلند');
  const reset = page.waitForResponse(`${E2E_API_BASE_URL}/auth/password-reset/confirm`);
  await page.getByRole('button', { name: t.resetPassword!.submit! }).click();
  expect((await reset).status()).toBe(400);
  await expect(page.getByRole('heading', { name: t.resetPassword!.invalidTitle! })).toBeFocused();
  await expect(page.getByRole('link', { name: t.resetPassword!.requestNew! })).toHaveAttribute(
    'href',
    '/fa/auth/forgot-password',
  );

  // Nothing was ever sent to the unknown address.
  expect(outboxFor(unknown)).toHaveLength(0);
});
