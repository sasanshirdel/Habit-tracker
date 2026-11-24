import { describe, expect, inject, it } from 'vitest';

/**
 * HTTP route tests against `next start` (backlog P1-10, with the P1-08 CSP): locale negotiation,
 * `<html lang dir>`, localized content and the CSP nonce surviving the next-intl middleware.
 */
const baseUrl = inject('baseUrl');

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, { redirect: 'manual', headers });
}

function htmlTag(html: string): string {
  return /<html[^>]*>/.exec(html)?.[0] ?? '';
}

function cspNonce(res: Response): string {
  return /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1] ?? '';
}

describe('/ negotiates the locale and redirects', () => {
  it.each([
    [{ 'accept-language': 'fa-IR,fa;q=0.9' }, '/fa'],
    [{ 'accept-language': 'en-US,en;q=0.9' }, '/en'],
    [{ 'accept-language': 'de-DE' }, '/en'],
    [{ 'accept-language': 'fa', cookie: 'NEXT_LOCALE=en' }, '/en'],
    [{ 'accept-language': 'en', cookie: 'NEXT_LOCALE=fa' }, '/fa'],
  ])('%j → %s (307, same origin, varies on the inputs)', async (headers, target) => {
    const res = await get('/', headers);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', baseUrl).href).toBe(`${baseUrl}${target}`);
    expect(res.headers.get('vary')).toMatch(/Accept-Language/);
    expect(res.headers.get('vary')).toMatch(/Cookie/);
  });

  it('prefixes deeper unprefixed paths and keeps the query', async () => {
    const res = await get('/pricing?plan=pro', { 'accept-language': 'fa' });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', baseUrl).href).toBe(
      `${baseUrl}/fa/pricing?plan=pro`,
    );
  });

  it('never redirects to another host', async () => {
    for (const path of ['//evil', '/%5Cevil', '/%2F%2Fevil/x']) {
      const res = await get(path);
      expect(new URL(res.headers.get('location') ?? '', baseUrl).origin, path).toBe(baseUrl);
    }
  });
});

describe.each([
  { locale: 'fa', dir: 'rtl', title: 'ردیاب عادت', heading: 'عادت‌های بهتر بسازید.', other: 'en' },
  {
    locale: 'en',
    dir: 'ltr',
    title: 'Habit Tracker',
    heading: 'Build better habits.',
    other: 'fa',
  },
])('/$locale', ({ locale, dir, title, heading, other }) => {
  it(`renders lang="${locale}" dir="${dir}" with localized content`, async () => {
    const res = await get(`/${locale}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const tag = htmlTag(html);
    expect(tag).toContain(`lang="${locale}"`);
    expect(tag).toContain(`dir="${dir}"`);
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(heading);
    // The switcher links to the other locale's home.
    expect(html).toMatch(new RegExp(`<a[^>]+href="/${other}"`));
    // Dates/numbers in the page follow the locale's digits.
    const time = /<time[^>]*>([^<]+)<\/time>/.exec(html)?.[1] ?? '';
    expect(time).toMatch(locale === 'fa' ? /[۰-۹]/ : /[0-9]/);
    expect(time).not.toMatch(locale === 'fa' ? /[0-9]/ : /[۰-۹]/);
  });

  it('keeps the per-request CSP nonce on every script (P1-08 through next-intl)', async () => {
    const res = await get(`/${locale}`);
    const nonce = cspNonce(res);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).toContain(`nonce="${nonce}"`);
    expect(cspNonce(await get(`/${locale}`))).not.toBe(nonce);
  });

  it('sends hreflang alternates and the static security headers', async () => {
    const res = await get(`/${locale}`);
    expect(res.headers.get('link')).toContain('hreflang="fa"');
    expect(res.headers.get('link')).toContain('hreflang="en"');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it(`remembers /${locale} in a Secure, SameSite=Lax cookie when the browser prefers another`, async () => {
    const res = await get(`/${locale}`, { 'accept-language': other });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^NEXT_LOCALE=${locale};`));
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=lax/i);
  });
});

describe('unknown paths', () => {
  it('404 under a locale with the localized not-found tree (fa, rtl)', async () => {
    const res = await get('/fa/does-not-exist');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('noindex');
    // Next.js 16.4 draws a render-time notFound() in the browser: the localized tree (inside the
    // locale layout, with lang/dir) is in the RSC payload, the server HTML is the error shell.
    // When upstream fixes vercel/next.js#99793 the first branch takes over — tighten it then.
    if (htmlTag(html).includes('__next_error__')) {
      expect(html).toContain('صفحه پیدا نشد');
      expect(html).toMatch(/\\"lang\\":\\"fa\\",\\"dir\\":\\"rtl\\"/);
    } else {
      expect(htmlTag(html)).toContain('dir="rtl"');
      expect(html).toContain('صفحه پیدا نشد');
    }
  });

  it('an unsupported locale segment never renders as a locale', async () => {
    const res = await get('/de', { 'accept-language': 'en' });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', baseUrl).pathname).toBe('/en/de');
  });
});
