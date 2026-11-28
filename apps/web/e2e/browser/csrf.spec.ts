import { E2E_API_BASE_URL, SIGNED_OUT } from './env';
import { cspViolations, expect, test } from './fixtures';

/**
 * Sessions and CSRF in a real browser (backlog P2-03, ADR-0019): the web origin calls the API
 * cross-origin with credentials, so this exercises the `__Host-session` cookie, the CORS preflight
 * for `X-CSRF-Token`, the browser's own `Origin` header and the API's 401/403 answers.
 *
 * Deliberate 401/403 responses make Chromium log "Failed to load resource" console errors, so the
 * automatic console guard is off here; CSP violations are still asserted.
 */
test.use({ allowPageErrors: true });
// Its own account and session: signing in would revoke the shared session of the other tests.
test.use({ storageState: SIGNED_OUT });

interface Result {
  status: number;
  body: unknown;
}

test('sign-in, session read and CSRF-protected sign-out-everywhere from the web origin', async ({
  page,
}) => {
  await page.goto('/en/status');
  const email = `browser.csrf.${Date.now()}@example.test`;
  const password = 'correct horse battery staple';

  const results = await page.evaluate(
    async ({ api, email, password }) => {
      const call = async (
        path: string,
        init: RequestInit & { json?: unknown } = {},
      ): Promise<{ status: number; body: unknown }> => {
        const headers = new Headers(init.headers);
        headers.set('accept', 'application/json');
        if (init.json !== undefined) headers.set('content-type', 'application/json');
        const res = await fetch(`${api}${path}`, {
          ...init,
          headers,
          body: init.json === undefined ? undefined : JSON.stringify(init.json),
          credentials: 'include',
        });
        const text = await res.text();
        return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
      };
      const out: Record<string, { status: number; body: unknown }> = {};
      out.anonymous = await call('/auth/session');
      out.register = await call('/auth/register', {
        method: 'POST',
        json: { email, password, locale: 'en', timezone: 'UTC' },
      });
      out.login = await call('/auth/login', { method: 'POST', json: { email, password } });
      out.session = await call('/auth/session');
      const csrf = (out.session.body as { csrfToken: string }).csrfToken;
      out.withoutToken = await call('/auth/logout-everywhere', { method: 'POST' });
      out.withToken = await call('/auth/logout-everywhere', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf },
      });
      out.after = await call('/auth/session');
      return out;
    },
    { api: E2E_API_BASE_URL, email, password },
  );

  const code = (r: Result | undefined) =>
    (r?.body as { error?: { code?: string } } | null)?.error?.code;
  expect(results.anonymous?.status).toBe(401);
  expect(code(results.anonymous)).toBe('UNAUTHENTICATED');
  expect(results.register?.status).toBe(202);
  expect(results.login?.status).toBe(200);
  const loginBody = results.login?.body as { csrfToken: string; user: { email: string } };
  expect(loginBody.user.email).toBe(email);
  // The cookie was stored and sent back cross-origin; the token matches the one from sign-in.
  expect(results.session?.status).toBe(200);
  expect((results.session?.body as { csrfToken: string }).csrfToken).toBe(loginBody.csrfToken);
  // The browser sent its own allowed Origin, so only the missing token is refused.
  expect(results.withoutToken?.status).toBe(403);
  expect(code(results.withoutToken)).toBe('CSRF_FAILED');
  // The preflight allowed X-CSRF-Token and the request went through.
  expect(results.withToken?.status).toBe(204);
  expect(results.after?.status).toBe(401);

  // The session lives in the API origin's HttpOnly cookie: nothing readable by page scripts.
  expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-session');
  expect(await cspViolations(page)).toEqual([]);
});
