import type { Page } from '@playwright/test';
import { E2E_API_BASE_URL, E2E_WEB_ORIGIN, SIGNED_OUT, clientAddressFor, viewports } from './env';
import {
  UNAUTHENTICATED_CONSOLE_ERROR,
  expect,
  messages,
  openApp,
  presentClientAddress,
  test,
} from './fixtures';

/**
 * Profile and preferences in a real browser against the real API (backlog P2-07, ADR-0024):
 * validation errors, the display name and every preference persisting across reloads, the theme
 * applying at once and following the account to a new browser, the profile time zone and
 * calendar driving dates on the security page, and saving a new language switching the route
 * fa ↔ en.
 *
 * Expected console errors: the signed-out session check (401) before signing in.
 */
test.use({ storageState: SIGNED_OUT, expectedConsoleErrors: [UNAUTHENTICATED_CONSOLE_ERROR] });

const PASSWORD = 'profile pass phrase 2026';
type Locale = 'en' | 'fa';

const settings = (locale: Locale) =>
  messages(locale).settings as unknown as {
    profile: Record<string, string>;
    preferences: Record<string, string>;
  };
const themeLabel = (locale: Locale) => messages(locale).theme!.label!;
const auth = (locale: Locale) =>
  messages(locale).auth as unknown as Record<string, Record<string, string>>;
const uniqueEmail = (tag: string) =>
  `browser.profile.${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;

async function registerViaApi(page: Page, email: string, locale: Locale) {
  await page.goto(`/${locale}/auth/sign-in`);
  const status = await page.evaluate(
    async ({ api, email, password, locale }) =>
      (
        await fetch(`${api}/auth/register`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, locale, timezone: 'UTC' }),
        })
      ).status,
    { api: E2E_API_BASE_URL, email, password: PASSWORD, locale },
  );
  expect(status).toBe(202);
}

async function signIn(page: Page, locale: Locale, email: string) {
  const t = auth(locale);
  await page.goto(`/${locale}/auth/sign-in`);
  await page.getByLabel(t.fields!.email!).fill(email);
  await page.getByLabel(t.fields!.password!, { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: t.signIn!.submit! }).click();
  await expect(page).toHaveURL(`/${locale}/overview`);
}

function patchResponse(page: Page, path: 'profile' | 'preferences') {
  return page.waitForResponse(
    (r) => r.url() === `${E2E_API_BASE_URL}/account/${path}` && r.request().method() === 'PATCH',
  );
}

test('desktop · /en: display name and preferences persist; theme, time zone and calendar apply; language switches the route', async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize(viewports.desktop);
  const email = uniqueEmail('en');
  await registerViaApi(page, email, 'en');
  await signIn(page, 'en', email);

  // Settings → Profile.
  const p = settings('en').profile;
  await openApp(page, '/en/settings');
  await page.getByRole('link', { name: new RegExp(p.title!) }).click();
  await expect(page).toHaveURL('/en/settings/profile');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.title!);
  const name = page.getByRole('textbox', { name: p.displayName! });
  await expect(name).toHaveValue('');

  // Validation error: too long, shown inline, nothing sent.
  await name.fill('x'.repeat(101));
  await page.getByRole('button', { name: p.save! }).click();
  await expect(page.getByText('Use at most 100 characters.')).toBeVisible();
  await expect(name).toHaveAttribute('aria-invalid', 'true');

  // A valid, mixed-script name is normalised and stored.
  await name.fill('  Sara   سارا ');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  const savedProfile = patchResponse(page, 'profile');
  await page.getByRole('button', { name: p.save! }).click();
  expect((await savedProfile).status()).toBe(200);
  await expect(page.getByText(p.saved!, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: p.displayName! })).toHaveValue('Sara سارا');

  // Settings → Preferences: theme, time zone, calendar, week start.
  const pr = settings('en').preferences;
  await openApp(page, '/en/settings/preferences');
  const form = page.locator('[data-preferences-form]');
  await expect(form.getByRole('combobox', { name: pr.calendar! })).toHaveValue('gregorian');
  await expect(form.getByRole('combobox', { name: pr.weekStart! })).toHaveValue('monday');
  await form.getByRole('combobox', { name: themeLabel('en') }).selectOption('light');
  await form.getByRole('combobox', { name: pr.timeZone! }).selectOption('Asia/Tehran');
  await form.getByRole('combobox', { name: pr.calendar! }).selectOption('solar_hijri');
  await form.getByRole('combobox', { name: pr.weekStart! }).selectOption('saturday');
  const savedPrefs = patchResponse(page, 'preferences');
  await form.getByRole('button', { name: pr.save! }).click();
  const prefsResponse = await savedPrefs;
  expect(prefsResponse.status()).toBe(200);
  expect(prefsResponse.request().postDataJSON()).toEqual({
    timezone: 'Asia/Tehran',
    theme: 'light',
    calendar: 'solar_hijri',
    weekStart: 'saturday',
  });
  await expect(page.getByText(pr.saved!, { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // After a reload the server renders the theme from the cookie (no flash) and the form shows
  // the stored values.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(form.getByRole('combobox', { name: pr.timeZone! })).toHaveValue('Asia/Tehran');
  await expect(form.getByRole('combobox', { name: pr.calendar! })).toHaveValue('solar_hijri');
  await expect(form.getByRole('combobox', { name: pr.weekStart! })).toHaveValue('saturday');

  // Dates already shown in the app (security activity) use the profile zone and calendar.
  await openApp(page, '/en/settings/security');
  const signIn1 = page.locator('[data-security-events] time').first();
  await expect(signIn1).toBeVisible();
  const instant = await signIn1.getAttribute('datetime');
  const expected = new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tehran',
    calendar: 'persian',
  }).format(new Date(instant!));
  await expect(signIn1).toHaveText(expected);

  // The theme follows the account to a browser that never chose one.
  const other = await browser.newContext({ storageState: SIGNED_OUT });
  await presentClientAddress(other, clientAddressFor(`${testInfo.testId}-other`));
  const otherPage = await other.newPage();
  await signIn(otherPage, 'en', email);
  await expect(otherPage.locator('html')).toHaveAttribute('data-theme', 'light');
  await other.close();

  // A new language: the page moves to /fa and stays there after a reload.
  await openApp(page, '/en/settings/preferences');
  await form.getByRole('combobox', { name: pr.language! }).selectOption('fa');
  const toFa = patchResponse(page, 'preferences');
  await form.getByRole('button', { name: pr.save! }).click();
  expect((await toFa).status()).toBe(200);
  await expect(page).toHaveURL('/fa/settings/preferences');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const fa = settings('fa').preferences;
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(fa.title!);
  await page.reload();
  await expect(form.getByRole('combobox', { name: fa.language! })).toHaveValue('fa');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');

  // …and back to English from the Persian page.
  await form.getByRole('combobox', { name: fa.language! }).selectOption('en');
  await form.getByRole('button', { name: fa.save! }).click();
  await expect(page).toHaveURL('/en/settings/preferences');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('phone · /fa: Persian labels, RTL layout without overflow, time-zone validation is server-checked too', async ({
  page,
}) => {
  await page.setViewportSize(viewports.phone);
  const email = uniqueEmail('fa');
  await registerViaApi(page, email, 'fa');
  await signIn(page, 'fa', email);
  const fa = settings('fa').preferences;
  await openApp(page, '/fa/settings/preferences');
  const form = page.locator('[data-preferences-form]');
  // Registered in Persian: Solar Hijri calendar and Saturday week start by default.
  await expect(form.getByRole('combobox', { name: fa.calendar! })).toHaveValue('solar_hijri');
  await expect(form.getByRole('combobox', { name: fa.weekStart! })).toHaveValue('saturday');
  await expect(form.getByRole('combobox', { name: fa.timeZone! })).toHaveAttribute('dir', 'ltr');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // The API rejects a zone the form would never offer (same shared schema on the server). Sent
  // with the context's own cookies outside the page, so the 400 is not a page console error.
  const session = await (await page.request.get(`${E2E_API_BASE_URL}/auth/session`)).json();
  const res = await page.request.patch(`${E2E_API_BASE_URL}/account/preferences`, {
    headers: { origin: E2E_WEB_ORIGIN, 'x-csrf-token': session.csrfToken as string },
    data: { timezone: 'Mars/Olympus_Mons' },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error.code).toBe('VALIDATION_FAILED');
  await page.reload();
  await expect(form.getByRole('combobox', { name: fa.timeZone! })).toHaveValue('UTC');
});
