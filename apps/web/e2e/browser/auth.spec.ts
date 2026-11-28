import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  E2E_API_BASE_URL,
  SHARED_ACCOUNT,
  SIGNED_OUT,
  directionOf,
  viewports,
  type Locale,
} from './env';
import { UNAUTHENTICATED_CONSOLE_ERROR, expect, messages, openApp, test } from './fixtures';

/**
 * Authentication journeys in a real browser against the real API (backlog P2-09): sign-up →
 * sign-in → app → sign-out in English (LTR, desktop) and Persian (RTL, phone, arriving from a
 * protected page), the generic wrong-password message, the redirect of signed-out visitors, no
 * flash of app content, and the open-redirect guard on `next`.
 *
 * The signed-out session check answers 401, which Chromium logs as a console error: that one
 * message is expected; any other console error, page error or CSP violation still fails.
 * Rate limits: each test presents its own client address (P2-04, `clientAddressFor`), so the
 * `auth` class (10 per 5 minutes) budgets each test on its own.
 */
test.use({ expectedConsoleErrors: [UNAUTHENTICATED_CONSOLE_ERROR] });

type AuthMessages = {
  signIn: Record<string, string>;
  signUp: Record<string, string>;
  fields: Record<string, string>;
  errors: Record<string, string>;
  session: Record<string, string>;
};
const auth = (locale: Locale) => messages(locale).auth as unknown as AuthMessages;
const nav = (locale: Locale) => messages(locale).nav!;

const uniqueEmail = (tag: string) =>
  `browser.${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;

async function fillCredentials(page: Page, locale: Locale, email: string, password: string) {
  const t = auth(locale);
  await page.getByLabel(t.fields.email!).fill(email);
  // Exact: the visibility toggle's name ("Show password") also contains "Password".
  await page.getByLabel(t.fields.password!, { exact: true }).fill(password);
}

test.describe('signed out', () => {
  test.use({ storageState: SIGNED_OUT });

  test.describe('desktop · /en', () => {
    test.use({ viewport: viewports.desktop });

    test('sign up → sign in → app → sign out, then the app sends you to sign-in', async ({
      page,
    }) => {
      const t = auth('en');
      const email = uniqueEmail('journey.en');
      const password = 'a long journey pass phrase';

      await page.goto('/en/auth/sign-up');
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.signUp.title!);
      await fillCredentials(page, 'en', email, password);
      await page.getByRole('button', { name: t.signUp.submit! }).click();

      // 202 for any address: a neutral confirmation, focused, and no session yet.
      const accepted = page.getByRole('heading', { name: t.signUp.acceptedTitle! });
      await expect(accepted).toBeFocused();
      await page.getByRole('link', { name: t.signUp.acceptedAction! }).click();
      await expect(page).toHaveURL('/en/auth/sign-in');

      await fillCredentials(page, 'en', email, password);
      await page.getByRole('button', { name: t.signIn.submit! }).click();
      await expect(page).toHaveURL('/en/overview');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(nav('en').overview!);
      // Nothing about the session is readable by page scripts or kept in web storage.
      expect(
        await page.evaluate(() => ({
          cookie: document.cookie.includes('session'),
          storage: localStorage.length + sessionStorage.length,
        })),
      ).toEqual({ cookie: false, storage: 0 });

      await page.getByRole('button', { name: t.session.account! }).click();
      await expect(page.getByRole('menu')).toContainText(email);
      const logout = page.waitForResponse(`${E2E_API_BASE_URL}/auth/logout`);
      await page.getByRole('menuitem', { name: t.session.signOut! }).click();
      expect((await logout).status()).toBe(204);
      await expect(page).toHaveURL('/en/auth/sign-in');
      await expect(page.getByText(t.session.signedOut!, { exact: true })).toBeVisible();

      // The session is gone on the server too: the app bounces to sign-in, remembering the page.
      await page.goto('/en/habits');
      await expect(page).toHaveURL('/en/auth/sign-in?next=%2Fhabits');
    });

    test('a wrong password gets the generic message and an empty, focused password field', async ({
      page,
    }) => {
      const t = auth('en');
      const { email } = JSON.parse(readFileSync(SHARED_ACCOUNT, 'utf8')) as { email: string };
      await page.goto('/en/auth/sign-in');
      await fillCredentials(page, 'en', email, 'definitely not the password');
      const login = page.waitForResponse(`${E2E_API_BASE_URL}/auth/login`);
      await page.getByRole('button', { name: t.signIn.submit! }).click();
      expect((await login).status()).toBe(401);
      // The form's alert (not Next's route announcer, which also has role=alert).
      await expect(page.locator('[data-slot="alert"]')).toHaveText(t.errors.invalidCredentials!);
      const password = page.getByLabel(t.fields.password!, { exact: true });
      await expect(password).toHaveValue('');
      await expect(password).toBeFocused();
      await expect(page).toHaveURL('/en/auth/sign-in');
    });

    test('a signed-out visitor never sees app content before the redirect', async ({ page }) => {
      // Hold the session check back so the in-between state can be inspected.
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(`${E2E_API_BASE_URL}/auth/session`, async (route) => {
        await held;
        await route.continue();
      });
      await page.goto('/en/journal?view=week');
      await expect(page.locator('[data-auth-gate="checking"]')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
      await expect(page.locator('[data-slot="empty-state"]')).toHaveCount(0);
      release();
      await expect(page).toHaveURL('/en/auth/sign-in?next=%2Fjournal%3Fview%3Dweek');
    });
  });

  test.describe('phone · /fa', () => {
    test.use({ viewport: viewports.phone });

    test('from a protected page: sign-in → sign-up → sign in → back to that page, in RTL', async ({
      page,
    }) => {
      const t = auth('fa');
      const email = uniqueEmail('journey.fa');
      const password = 'عبارت عبور بلند و امن';

      await page.goto('/fa/habits');
      await expect(page).toHaveURL('/fa/auth/sign-in?next=%2Fhabits');
      await expect(page.locator('html')).toHaveAttribute('dir', directionOf.fa);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.signIn.title!);

      // RTL layout: labels start at the right edge; email and password stay left-to-right.
      const emailField = page.getByLabel(t.fields.email!);
      await expect(emailField).toHaveAttribute('dir', 'ltr');
      const label = await page.getByText(t.fields.email!, { exact: true }).boundingBox();
      const field = await emailField.boundingBox();
      expect(label && field).toBeTruthy();
      expect(Math.round(label!.x + label!.width)).toBeGreaterThan(
        Math.round(field!.x + field!.width) - 2,
      );
      const width = await page.evaluate(() => document.documentElement.clientWidth);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );

      await page.getByRole('link', { name: t.signIn.createAccount! }).click();
      await expect(page).toHaveURL('/fa/auth/sign-up?next=%2Fhabits');
      await fillCredentials(page, 'fa', email, password);
      // Show/hide keeps the value and reports its state.
      const toggle = page.getByRole('button', { name: t.fields.showPassword! });
      // The password control is LTR as a whole: the toggle sits at the end of the text (right).
      const passwordBox = await page.getByLabel(t.fields.password!, { exact: true }).boundingBox();
      const toggleBox = await toggle.boundingBox();
      expect(toggleBox!.x).toBeGreaterThan(passwordBox!.x + passwordBox!.width / 2);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByLabel(t.fields.password!, { exact: true })).toHaveAttribute(
        'type',
        'text',
      );
      await page.getByRole('button', { name: t.signUp.submit! }).click();
      await expect(page.getByRole('heading', { name: t.signUp.acceptedTitle! })).toBeFocused();
      await page.getByRole('link', { name: t.signUp.acceptedAction! }).click();
      await expect(page).toHaveURL('/fa/auth/sign-in?next=%2Fhabits');

      await fillCredentials(page, 'fa', email, password);
      await page.getByRole('button', { name: t.signIn.submit! }).click();
      await expect(page).toHaveURL('/fa/habits');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(nav('fa').habits!);
    });
  });
});

test.describe('signed in (shared account)', () => {
  test('the app renders behind the gate and shows the account menu', async ({ page }) => {
    await openApp(page, '/en/settings');
    await expect(page.getByRole('button', { name: auth('en').session.account! })).toBeVisible();
  });

  test('sign-in sends a signed-in visitor on, honouring only a safe next (no open redirect)', async ({
    page,
  }) => {
    for (const evil of [
      'https://evil.example/overview',
      '//evil.example',
      '/\\evil.example',
      '/%09/evil.example',
      'javascript:alert(1)',
    ]) {
      await page.goto(`/en/auth/sign-in?next=${encodeURIComponent(evil)}`);
      await expect(page, evil).toHaveURL('/en/overview');
    }
    await page.goto(`/en/auth/sign-in?next=${encodeURIComponent('/goals')}`);
    await expect(page).toHaveURL('/en/goals');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(nav('en').goals!);
  });
});
