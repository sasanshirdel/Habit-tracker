import type { Page } from '@playwright/test';
import { E2E_API_BASE_URL, SIGNED_OUT, viewports } from './env';
import { UNAUTHENTICATED_CONSOLE_ERROR, expect, messages, openApp, test } from './fixtures';

/**
 * Server answers inside the forms, in a real browser against the real API (backlog P2-09,
 * ADR-0027):
 *
 * - a field the **API** refuses (`400 VALIDATION_FAILED`, `details.issues[]`) is marked on that
 *   field — `aria-invalid`, the localized message linked by `aria-describedby`, focus — with no
 *   form-level alert. The browser validates with the same shared schemas, so to reach the API's
 *   verdict the request is changed in flight (`route.fallback` with new post data, keeping the
 *   suite's per-test client address); the API's real response comes back to the page;
 * - a session that ends under an open page: the next request's 401 re-checks the session, the
 *   gate sends the user to sign-in (saying why) with the page as `next`, and signing in returns
 *   there — once, no redirect loop.
 *
 * Expected console errors: Chromium logs the 401s (signed-out session checks) and the provoked
 * 400s.
 */
// One pattern: a two-element array would be read as Playwright's `[value, fixtureOptions]` tuple.
const EXPECTED_CONSOLE_ERRORS = new RegExp(
  UNAUTHENTICATED_CONSOLE_ERROR.source.replace('401', '(?:400|401)'),
);
test.use({ storageState: SIGNED_OUT, expectedConsoleErrors: [EXPECTED_CONSOLE_ERRORS] });

type Locale = 'en' | 'fa';
const PASSWORD = 'forms session pass phrase';
const auth = (locale: Locale) =>
  messages(locale).auth as unknown as Record<string, Record<string, string>>;
const profile = (locale: Locale) =>
  (messages(locale).settings as unknown as { profile: Record<string, string> }).profile;
const uniqueEmail = (tag: string) =>
  `browser.forms.${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;

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

async function fillSignIn(page: Page, locale: Locale, email: string) {
  const t = auth(locale);
  await page.getByLabel(t.fields!.email!).fill(email);
  await page.getByLabel(t.fields!.password!, { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: t.signIn!.submit! }).click();
}

/** The accessible description of a field: the texts its `aria-describedby` points at. */
async function descriptionOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' | '),
  );
}

test('desktop · /en: a display name the API refuses is marked on the field, focused, then fixed', async ({
  page,
}) => {
  await page.setViewportSize(viewports.desktop);
  const p = profile('en');
  const email = uniqueEmail('field.en');
  await registerViaApi(page, email, 'en');
  await page.goto('/en/auth/sign-in');
  await fillSignIn(page, 'en', email);
  await expect(page).toHaveURL('/en/overview');
  await openApp(page, '/en/settings/profile');

  // The browser accepts "Sara"; in flight it becomes a name with a right-to-left override
  // (U+202E), which only the API's schema refuses (400 VALIDATION_FAILED, body.displayName).
  let tampered = 0;
  await page.route(`${E2E_API_BASE_URL}/account/profile`, async (route) => {
    if (route.request().method() !== 'PATCH' || tampered > 0) return route.fallback();
    tampered++;
    await route.fallback({ postData: JSON.stringify({ displayName: 'Sara\u202Eevil' }) });
  });

  const name = page.getByRole('textbox', { name: p.displayName! });
  await name.fill('Sara');
  const refused = page.waitForResponse(
    (r) => r.url() === `${E2E_API_BASE_URL}/account/profile` && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: p.save! }).click();
  const response = await refused;
  expect(response.status()).toBe(400);
  const body = (await response.json()) as {
    error: { code: string; details: { issues: { field: string }[] } };
  };
  expect(body.error.code).toBe('VALIDATION_FAILED');
  expect(body.error.details.issues.map((issue) => issue.field)).toEqual(['body.displayName']);

  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toBeFocused();
  expect(await descriptionOf(page, '[data-profile-form] input')).toContain(p.invalidCharacters!);
  await expect(page.locator('[data-profile-form] [role="alert"]')).toHaveCount(0);

  // Editing clears the mark; the next save goes through untouched.
  await name.fill('Sara Ahmadi');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  const saved = page.waitForResponse(
    (r) => r.url() === `${E2E_API_BASE_URL}/account/profile` && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: p.save! }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText(p.saved!, { exact: true })).toBeVisible();
});

test('phone · /fa: a password the API refuses at sign-up is marked in Persian, focused, nothing registered', async ({
  page,
}) => {
  await page.setViewportSize(viewports.phone);
  const t = auth('fa');
  const email = uniqueEmail('field.fa');
  await page.route(`${E2E_API_BASE_URL}/auth/register`, async (route) => {
    const sent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fallback({ postData: JSON.stringify({ ...sent, password: 'short' }) });
  });

  await page.goto('/fa/auth/sign-up');
  await page.getByLabel(t.fields!.email!).fill(email);
  const password = page.getByLabel(t.fields!.password!, { exact: true });
  await password.fill(PASSWORD);
  const refused = page.waitForResponse(`${E2E_API_BASE_URL}/auth/register`);
  await page.getByRole('button', { name: t.signUp!.submit! }).click();
  expect((await refused).status()).toBe(400);

  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(password).toBeFocused();
  // "Use at least ۸ characters." in Persian, linked to the field (with the password hint).
  const tooShort = t.validation!.passwordTooShort!.replace('{min, number}', '۸');
  expect(await descriptionOf(page, `input[type="password"], input[name="password"]`)).toContain(
    tooShort,
  );
  // No form-level alert (Next.js's route announcer is an empty `role="alert"` outside <main>).
  await expect(page.locator('main [role="alert"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: t.signUp!.acceptedTitle! })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('desktop · /en: the session ends under an open page → the next request goes to sign-in → back to the page', async ({
  page,
}) => {
  await page.setViewportSize(viewports.desktop);
  const t = auth('en');
  const p = profile('en');
  const email = uniqueEmail('expired.en');
  await registerViaApi(page, email, 'en');
  await page.goto('/en/auth/sign-in');
  await fillSignIn(page, 'en', email);
  await expect(page).toHaveURL('/en/overview');
  await openApp(page, '/en/settings/profile');
  const name = page.getByRole('textbox', { name: p.displayName! });
  await expect(name).toBeVisible();

  // The session cookie disappears (expired, or ended elsewhere) while the page stays open.
  await page.context().clearCookies();
  const sessionChecks: string[] = [];
  page.on('request', (request) => {
    if (request.url() === `${E2E_API_BASE_URL}/auth/session`) sessionChecks.push(request.url());
  });

  await name.fill('Sara');
  const rejected = page.waitForResponse(
    (r) => r.url() === `${E2E_API_BASE_URL}/account/profile` && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: p.save! }).click();
  expect((await rejected).status()).toBe(401);

  // One session re-check, then sign-in with this page as `next` and the reason; no app content.
  await expect(page).toHaveURL('/en/auth/sign-in?next=%2Fsettings%2Fprofile');
  await expect(page.locator('[data-session-expired]')).toHaveText(t.session!.expired!);
  await expect(page.locator('[data-session-expired]')).toHaveAttribute('role', 'status');
  expect(sessionChecks.length).toBe(1);

  // Signing in returns to the page — and stays there (no loop back to sign-in).
  await fillSignIn(page, 'en', email);
  await expect(page).toHaveURL('/en/settings/profile');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.title!);
  await expect(page.getByRole('textbox', { name: p.displayName! })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL('/en/settings/profile');
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    'nothing in web storage',
  ).toBe(0);
});
