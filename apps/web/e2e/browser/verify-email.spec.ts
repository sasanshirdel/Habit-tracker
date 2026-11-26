import type { Page } from '@playwright/test';
import { E2E_API_BASE_URL, E2E_WEB_ORIGIN, SIGNED_OUT, directionOf, viewports } from './env';
import {
  UNAUTHENTICATED_CONSOLE_ERROR,
  expect,
  messages,
  test,
  verificationLinkIn,
  waitForEmails,
} from './fixtures';

/**
 * Email verification in a real browser against the real API and worker (backlog P2-04,
 * ADR-0021): the worker writes emails to the outbox (`MAIL_TRANSPORT=outbox`), tests open the
 * links. English (LTR, desktop) and Persian (RTL, phone).
 *
 * Expected console errors: the signed-out session check (401) and, where a test uses a dead link
 * on purpose, the confirm request's 400.
 */
// One pattern: Playwright reads a two-element array whose second item is an object (a RegExp is
// one) as `[value, fixtureOptions]`.
const EXPECTED_CONSOLE_ERRORS = new RegExp(
  UNAUTHENTICATED_CONSOLE_ERROR.source.replace('401', '(?:400|401)'),
);
test.use({ storageState: SIGNED_OUT, expectedConsoleErrors: [EXPECTED_CONSOLE_ERRORS] });

type AuthMessages = Record<string, Record<string, string>>;
const auth = (locale: 'en' | 'fa') => messages(locale).auth as unknown as AuthMessages;

const uniqueEmail = (tag: string) =>
  `browser.verify.${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;

async function signIn(page: Page, locale: 'en' | 'fa', email: string, password: string) {
  const t = auth(locale);
  await page.goto(`/${locale}/auth/sign-in`);
  await page.getByLabel(t.fields!.email!).fill(email);
  await page.getByLabel(t.fields!.password!, { exact: true }).fill(password);
  await page.getByRole('button', { name: t.signIn!.submit! }).click();
  await expect(page).toHaveURL(`/${locale}/overview`);
}

test('desktop · /en: sign up → "check your email" → open the emailed link → confirm → signed in without a reminder', async ({
  page,
}) => {
  await page.setViewportSize(viewports.desktop);
  const t = auth('en');
  const email = uniqueEmail('en');
  const password = 'a long verification pass phrase';

  await page.goto('/en/auth/sign-up');
  await page.getByLabel(t.fields!.email!).fill(email);
  await page.getByLabel(t.fields!.password!, { exact: true }).fill(password);
  await page.getByRole('button', { name: t.signUp!.submit! }).click();
  await expect(page.getByRole('heading', { name: t.signUp!.acceptedTitle! })).toBeFocused();
  await expect(page.locator('[data-auth-step="accepted"]')).toContainText(email);

  const [message] = await waitForEmails(email);
  expect(message).toMatchObject({ template: 'identity.verify-email', locale: 'en' });
  const link = verificationLinkIn(message!);
  expect(link.startsWith(`${E2E_WEB_ORIGIN}/en/auth/verify-email#token=`)).toBe(true);

  // Opening the link changes nothing by itself and drops the token from the address bar.
  let confirms = 0;
  page.on('request', (request) => {
    if (request.url() === `${E2E_API_BASE_URL}/auth/verification/confirm`) confirms++;
  });
  await page.goto(link);
  const confirm = page.getByRole('button', { name: t.verifyEmail!.confirm! });
  await expect(confirm).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(confirms).toBe(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.verifyEmail!.title!);

  const response = page.waitForResponse(`${E2E_API_BASE_URL}/auth/verification/confirm`);
  await confirm.click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('heading', { name: t.verifyEmail!.verifiedTitle! })).toBeFocused();
  await page.getByRole('link', { name: t.verifyEmail!.continue! }).click();
  await expect(page).toHaveURL('/en/auth/sign-in');

  await signIn(page, 'en', email, password);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[data-verify-banner]')).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    'nothing in web storage',
  ).toBe(0);
});

test('phone · /fa: an unverified account sees the reminder in RTL, asks for a new link, and only the newest link works', async ({
  page,
}) => {
  await page.setViewportSize(viewports.phone);
  const t = auth('fa');
  const email = uniqueEmail('fa');
  const password = 'عبارت عبور بلند برای تأیید';

  // Sign up through the API (the form is covered above), in Persian.
  await page.goto('/fa/auth/sign-in');
  const registered = await page.evaluate(
    async ({ api, email, password }) =>
      (
        await fetch(`${api}/auth/register`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, locale: 'fa', timezone: 'Asia/Tehran' }),
        })
      ).status,
    { api: E2E_API_BASE_URL, email, password },
  );
  expect(registered).toBe(202);
  const [first] = await waitForEmails(email);
  expect(first).toMatchObject({ locale: 'fa', subject: expect.stringMatching(/[\u0600-\u06FF]/) });
  expect(first!.html).toContain('dir="rtl"');

  // Unverified accounts may sign in (ADR-0021); the app reminds them.
  await signIn(page, 'fa', email, password);
  const banner = page.locator('[data-verify-banner]');
  await expect(banner).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', directionOf.fa);
  await expect(banner).toContainText(t.verifyBanner!.title!);
  await expect(banner).toContainText(email);
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );

  const resend = page.waitForResponse(`${E2E_API_BASE_URL}/auth/verification/resend`);
  await banner.getByRole('button', { name: t.verifyBanner!.resend! }).click();
  expect((await resend).status()).toBe(202);
  await expect(banner.getByRole('status')).toHaveText(t.verifyBanner!.sent!);
  const [, second] = await waitForEmails(email, 2);

  // The first link was replaced by the second one.
  await page.goto(verificationLinkIn(first!));
  await page.getByRole('button', { name: t.verifyEmail!.confirm! }).click();
  await expect(page.getByRole('heading', { name: t.verifyEmail!.invalidTitle! })).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  await page.goto(verificationLinkIn(second!));
  await page.getByRole('button', { name: t.verifyEmail!.confirm! }).click();
  await expect(page.getByRole('heading', { name: t.verifyEmail!.verifiedTitle! })).toBeFocused();

  // Still signed in: back in the app the reminder is gone.
  await page.goto('/fa/habits');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[data-verify-banner]')).toHaveCount(0);
});

test('a link without a token explains what to do, in both languages', async ({ page }) => {
  for (const locale of ['en', 'fa'] as const) {
    await page.goto(`/${locale}/auth/verify-email`);
    await expect(page.locator('html')).toHaveAttribute('dir', directionOf[locale]);
    await expect(
      page.getByRole('heading', { name: auth(locale).verifyEmail!.invalidTitle! }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: auth(locale).verifyEmail!.signIn! }),
    ).toHaveAttribute('href', `/${locale}/auth/sign-in`);
  }
});
