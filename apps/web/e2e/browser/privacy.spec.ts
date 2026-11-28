import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { E2E_API_BASE_URL, SIGNED_OUT, directionOf, viewports } from './env';
import { UNAUTHENTICATED_CONSOLE_ERROR, expect, messages, test, waitForTemplate } from './fixtures';

/**
 * Data export and account deletion in a real browser against the real API and worker (backlog
 * P2-10, ADR-0025): Settings → Your data → download the JSON copy → delete the account (password
 * + typed address) → signed out → cannot sign in → the emailed restore link (worker's file outbox)
 * brings the account back → sign in again. English (LTR, desktop) and Persian (RTL, phone).
 *
 * Expected console errors: 401s — the signed-out session check and the refused sign-in of the
 * deleted account.
 */
test.use({ storageState: SIGNED_OUT, expectedConsoleErrors: [UNAUTHENTICATED_CONSOLE_ERROR] });

const PASSWORD = 'privacy pass phrase 2026';
type Tree = Record<string, unknown>;
/** A message by dotted path under `root`, e.g. `m('en', 'settings.privacy.export.download')`. */
function m(locale: 'en' | 'fa', path: string): string {
  let node: unknown = messages(locale) as unknown as Tree;
  for (const part of path.split('.')) node = (node as Tree)[part];
  if (typeof node !== 'string') throw new Error(`no message ${path}`);
  return node;
}
const uniqueEmail = (tag: string) =>
  `browser.privacy.${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;

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

async function fillSignIn(page: Page, locale: 'en' | 'fa', email: string) {
  await page.goto(`/${locale}/auth/sign-in`);
  await page.getByLabel(m(locale, 'auth.fields.email')).fill(email);
  await page.getByLabel(m(locale, 'auth.fields.password'), { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: m(locale, 'auth.signIn.submit') }).click();
}

test('desktop · /en: download my data → delete → signed out, cannot sign in → restore → sign in', async ({
  page,
}) => {
  await page.setViewportSize(viewports.desktop);
  const email = uniqueEmail('en');
  await registerViaApi(page, email, 'en');
  await fillSignIn(page, 'en', email);
  await expect(page).toHaveURL('/en/overview');

  // Settings → Your data.
  await page.goto('/en/settings');
  await page.getByRole('link', { name: new RegExp(m('en', 'settings.privacy.title')) }).click();
  await expect(page).toHaveURL('/en/settings/privacy');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    m('en', 'settings.privacy.title'),
  );

  // Download: a JSON file named by date with this account's data and no secrets.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: m('en', 'settings.privacy.export.download') }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^habit-tracker-data-\d{4}-\d{2}-\d{2}\.json$/);
  const text = readFileSync((await download.path())!, 'utf8');
  const data = JSON.parse(text) as {
    format: string;
    sections: { account: { user: { email: string }; preferences: { locale: string } } };
  };
  expect(data.format).toBe('habit-tracker.user-data-export');
  expect(data.sections.account.user.email).toBe(email);
  expect(data.sections.account.preferences.locale).toBe('en');
  expect(text).not.toContain('$argon2id$');
  await expect(
    page.getByText(m('en', 'settings.privacy.export.done'), { exact: true }),
  ).toBeVisible();

  // Delete: the dialog needs the password and the address typed out.
  await page.getByRole('button', { name: m('en', 'settings.privacy.delete.open') }).click();
  const dialog = page.getByRole('dialog', { name: m('en', 'settings.privacy.delete.dialogTitle') });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('30 days');
  await dialog
    .getByLabel(m('en', 'settings.privacy.delete.password'), { exact: true })
    .fill(PASSWORD);
  await dialog.getByLabel(m('en', 'settings.privacy.delete.confirmLabel')).fill(email);
  const deleted = page.waitForResponse(
    (r) => r.url() === `${E2E_API_BASE_URL}/account/deletion` && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: m('en', 'settings.privacy.delete.confirm') }).click();
  expect((await deleted).status()).toBe(202);
  await expect(page).toHaveURL('/en/auth/account-deleted');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    m('en', 'auth.accountDeleted.title'),
  );

  // Signed out: the app sends this browser to sign-in, and the account cannot sign in.
  await page.goto('/en/habits');
  await expect(page).toHaveURL('/en/auth/sign-in?next=%2Fhabits');
  await fillSignIn(page, 'en', email);
  await expect(page.getByText(m('en', 'auth.errors.invalidCredentials'))).toBeVisible();
  await expect(page).toHaveURL(/\/en\/auth\/sign-in/);

  // The emailed restore link brings it back (confirmed with a button), then sign-in works.
  const message = await waitForTemplate(email, 'identity.account-deleted');
  const link = /(https?:\/\/\S+\/auth\/restore-account#token=[A-Za-z0-9_-]{43})/.exec(
    message.text,
  )?.[1];
  expect(link).toBeTruthy();
  await page.goto(link!);
  await expect(page).toHaveURL('/en/auth/restore-account'); // token removed from the address bar
  await page.getByRole('button', { name: m('en', 'auth.restoreAccount.confirm') }).click();
  const restored = page.getByRole('heading', {
    name: m('en', 'auth.restoreAccount.restoredTitle'),
  });
  await expect(restored).toBeFocused();
  await page.getByRole('link', { name: m('en', 'auth.restoreAccount.signIn') }).click();
  await fillSignIn(page, 'en', email);
  await expect(page).toHaveURL('/en/overview');
});

test('phone · /fa: Persian, right-to-left; export works; deletion needs the typed address', async ({
  page,
}) => {
  await page.setViewportSize(viewports.phone);
  const email = uniqueEmail('fa');
  await registerViaApi(page, email, 'fa');
  await fillSignIn(page, 'fa', email);
  await expect(page).toHaveURL('/fa/overview');

  await page.goto('/fa/settings/privacy');
  await expect(page.locator('html')).toHaveAttribute('dir', directionOf.fa);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    m('fa', 'settings.privacy.title'),
  );
  await expect(page.locator('[data-delete-account]')).toContainText('۳۰');

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: m('fa', 'settings.privacy.export.download') }).click();
  expect((await downloading).suggestedFilename()).toMatch(/\.json$/);

  // Keyboard: open the dialog, a wrong address is refused locally, Escape closes it.
  const open = page.getByRole('button', { name: m('fa', 'settings.privacy.delete.open') });
  await open.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: m('fa', 'settings.privacy.delete.dialogTitle') });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel(m('fa', 'settings.privacy.delete.password'), { exact: true })
    .fill(PASSWORD);
  await dialog
    .getByLabel(m('fa', 'settings.privacy.delete.confirmLabel'))
    .fill('not-me@example.test');
  await dialog.getByRole('button', { name: m('fa', 'settings.privacy.delete.confirm') }).click();
  await expect(dialog.getByText(m('fa', 'settings.privacy.delete.confirmMismatch'))).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  // Still signed in: nothing was sent.
  await page.goto('/fa/habits');
  await expect(page).toHaveURL('/fa/habits');
});
