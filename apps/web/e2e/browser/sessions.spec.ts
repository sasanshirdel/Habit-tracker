import type { Browser, BrowserContext, Page } from '@playwright/test';
import { E2E_API_BASE_URL, SIGNED_OUT, clientAddressFor, directionOf, viewports } from './env';
import {
  UNAUTHENTICATED_CONSOLE_ERROR,
  expect,
  messages,
  presentClientAddress,
  test,
} from './fixtures';

/**
 * Session management and security activity in a real browser against the real API (backlog
 * P2-08, ADR-0023): one account signed in from independent browser contexts (separate cookie
 * jars = separate sessions, with different user agents); from Settings → Sessions and security
 * the user signs out one device and then all others, and each revoked browser is signed out on
 * its next request. English (LTR, desktop) and Persian (RTL, phone).
 *
 * Expected console errors: the signed-out session check (401) before signing in.
 */
test.use({ storageState: SIGNED_OUT, expectedConsoleErrors: [UNAUTHENTICATED_CONSOLE_ERROR] });

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const MAC_FIREFOX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.5; rv:145.0) Gecko/20100101 Firefox/145.0';
const PASSWORD = 'session pass phrase 2026';

/** A message of `settings.security` by dotted path, e.g. `m('en', 'sessions.revoked')`. */
function m(locale: 'en' | 'fa', path: string): string {
  let node: unknown = (messages(locale).settings as Record<string, unknown>).security;
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part];
  if (typeof node !== 'string') throw new Error(`no message settings.security.${path}`);
  return node;
}
const auth = (locale: 'en' | 'fa') =>
  messages(locale).auth as unknown as Record<string, Record<string, string>>;
const iso = (text: string) => `\u2068${text}\u2069`;

const uniqueEmail = (tag: string) =>
  `browser.sessions.${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;

async function registerViaApi(page: Page, email: string, locale: 'en' | 'fa') {
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
    { api: E2E_API_BASE_URL, email, password: PASSWORD, locale },
  );
  expect(status).toBe(202);
}

async function signIn(page: Page, locale: 'en' | 'fa', email: string) {
  const t = auth(locale);
  await page.goto(`/${locale}/auth/sign-in`);
  await page.getByLabel(t.fields!.email!).fill(email);
  await page.getByLabel(t.fields!.password!, { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: t.signIn!.submit! }).click();
  await expect(page).toHaveURL(`/${locale}/overview`);
}

/** Another browser (own cookie jar → own session) with its own user agent, signed in. */
async function otherDevice(
  browser: Browser,
  testId: string,
  userAgent: string,
  locale: 'en' | 'fa',
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: SIGNED_OUT, userAgent });
  await presentClientAddress(context, clientAddressFor(testId));
  const page = await context.newPage();
  await signIn(page, locale, email);
  return { context, page };
}

/** The other browser is signed out on its next request (the gate sends it to sign-in). */
async function expectSignedOut(page: Page, locale: 'en' | 'fa') {
  await page.goto(`/${locale}/habits`);
  await expect(page).toHaveURL(`/${locale}/auth/sign-in?next=%2Fhabits`);
}

test('desktop · /en: see devices → sign out one → sign out all others; activity recorded', async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize(viewports.desktop);
  const email = uniqueEmail('en');
  await registerViaApi(page, email, 'en');
  await signIn(page, 'en', email);
  const phone = await otherDevice(browser, testInfo.testId, ANDROID_CHROME, 'en', email);

  // Settings → Sessions and security.
  await page.goto('/en/settings');
  await page.getByRole('link', { name: new RegExp(m('en', 'title')) }).click();
  await expect(page).toHaveURL('/en/settings/security');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(m('en', 'title'));

  const sessions = page.locator('[data-sessions] li[data-session-id]');
  await expect(sessions).toHaveCount(2);
  const current = page.locator('[data-sessions] li[data-current]');
  await expect(current).toContainText(m('en', 'sessions.thisDevice'));
  await expect(current.getByRole('button')).toHaveCount(0); // this device: no "Sign out" here
  const phoneLabel = `${iso('Chrome')} on ${iso('Android')}`;
  await expect(page.locator('[data-sessions]')).toContainText(phoneLabel);

  // Sign out the phone, confirmed in a dialog.
  await page.getByRole('button', { name: `Sign out ${phoneLabel}` }).click();
  const dialog = page.getByRole('dialog', { name: m('en', 'sessions.revokeTitle') });
  await expect(dialog).toBeVisible();
  const revoked = page.waitForResponse(
    (r) =>
      r.url().startsWith(`${E2E_API_BASE_URL}/account/sessions/`) &&
      r.request().method() === 'DELETE',
  );
  await dialog.getByRole('button', { name: m('en', 'sessions.revokeConfirm') }).click();
  expect((await revoked).status()).toBe(204);
  await expect(page.getByText(m('en', 'sessions.revoked'))).toBeVisible();
  await expect(sessions).toHaveCount(1);
  await expect(page.locator('[data-only-this-device]')).toBeVisible();
  await expectSignedOut(phone.page, 'en');
  await phone.context.close();

  // Activity: newest first.
  const events = page.locator('[data-security-events] li[data-event-type]');
  await expect(events.first()).toHaveAttribute('data-event-type', 'session_revoked');
  await expect(events.first()).toContainText(m('en', 'activity.events.session_revoked'));
  await expect(page.locator('[data-security-events] li[data-event-type="sign_in"]')).toHaveCount(2);

  // Two more devices; "Sign out of all other devices" keeps this one.
  const laptop = await otherDevice(browser, testInfo.testId, MAC_FIREFOX, 'en', email);
  const tablet = await otherDevice(browser, testInfo.testId, ANDROID_CHROME, 'en', email);
  await page.reload();
  await expect(sessions).toHaveCount(3);
  await expect(page.locator('[data-sessions]')).toContainText(
    `${iso('Firefox')} on ${iso('macOS')}`,
  );
  await page.locator('[data-revoke-others]').click();
  const others = page.getByRole('dialog', { name: m('en', 'sessions.revokeOthersTitle') });
  await others.getByRole('button', { name: m('en', 'sessions.revokeOthersConfirm') }).click();
  await expect(page.getByText('2 devices were signed out.')).toBeVisible();
  await expect(sessions).toHaveCount(1);
  await expectSignedOut(laptop.page, 'en');
  await expectSignedOut(tablet.page, 'en');
  await laptop.context.close();
  await tablet.context.close();
  await expect(events.first()).toHaveAttribute('data-event-type', 'signed_out_other_sessions');

  // This browser is still signed in.
  await page.goto('/en/habits');
  await expect(page).toHaveURL('/en/habits');
});

test('phone · /fa: the page is Persian and right-to-left; keyboard reaches the device sign-out', async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize(viewports.phone);
  const email = uniqueEmail('fa');
  await registerViaApi(page, email, 'fa');
  await signIn(page, 'fa', email);
  const laptop = await otherDevice(browser, testInfo.testId, MAC_FIREFOX, 'fa', email);

  await page.goto('/fa/settings/security');
  await expect(page.locator('html')).toHaveAttribute('dir', directionOf.fa);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(m('fa', 'title'));
  await expect(page.getByRole('heading', { name: m('fa', 'sessions.title') })).toBeVisible();
  await expect(page.locator('[data-sessions] li[data-current]')).toContainText(
    m('fa', 'sessions.thisDevice'),
  );
  await expect(page.locator('[data-security-events] li').first()).toContainText(
    m('fa', 'activity.events.sign_in'),
  );

  // Keyboard only: focus the device's sign-out button, open the dialog, confirm.
  const revoke = page.getByRole('button', {
    name: `خروج ${iso('Firefox')} روی ${iso('macOS')}`,
  });
  await revoke.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: m('fa', 'sessions.revokeTitle') });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: m('fa', 'sessions.revokeConfirm') }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(m('fa', 'sessions.revoked'))).toBeVisible();
  await expect(page.locator('[data-only-this-device]')).toBeVisible();
  await expectSignedOut(laptop.page, 'fa');
  await laptop.context.close();
});
