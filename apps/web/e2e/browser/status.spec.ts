import { E2E_API_BASE_URL, E2E_WEB_ORIGIN, directionOf, locales } from './env';
import { expect, messages, test } from './fixtures';

/**
 * API smoke through the real stack (P1-12 demo, P1-13): the API on PostgreSQL + Redis, called
 * directly and from the browser through the web app's client — cross-origin, so CORS with
 * credentials and the CSP's `connect-src` for the API origin are exercised for real.
 */

test('the API answers liveness and readiness with request IDs', async ({ request }) => {
  const live = await request.get(`${E2E_API_BASE_URL}/health`);
  expect(live.status()).toBe(200);
  expect(live.headers()['x-request-id']).toBeTruthy();
  expect(await live.json()).toMatchObject({ status: 'ok' });

  const ready = await request.get(`${E2E_API_BASE_URL}/health/ready`);
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toMatchObject({ checks: { database: 'up', redis: 'up' } });
});

for (const locale of locales) {
  const t = messages(locale).status!;

  test(`/${locale}/status shows the live API and its dependencies`, async ({ page }) => {
    const readyResponse = page.waitForResponse(`${E2E_API_BASE_URL}/health/ready`);
    await page.goto(`/${locale}/status`);
    await expect(page.locator('html')).toHaveAttribute('dir', directionOf[locale]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.title!);

    // The browser called the API itself, cross-origin, with credentials allowed for this origin only.
    const response = await readyResponse;
    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBe(E2E_WEB_ORIGIN);
    expect(response.headers()['access-control-allow-credentials']).toBe('true');

    const api = page.getByRole('region', { name: t.api! });
    await expect(api).toHaveAttribute('aria-busy', 'false');
    await expect(api).toContainText(t.apiUp!);

    const deps = page.getByRole('region', { name: t.readiness! });
    await expect(deps).toHaveAttribute('aria-busy', 'false');
    await expect(deps).toContainText(t.allReady!);
    await expect(deps.locator('[data-check="database"]')).toHaveAttribute('data-status', 'up');
    await expect(deps.locator('[data-check="redis"]')).toHaveAttribute('data-status', 'up');
  });
}
