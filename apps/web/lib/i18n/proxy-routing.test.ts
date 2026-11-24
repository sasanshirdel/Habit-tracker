import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocalizedRequest, proxy } from '../../proxy';

const ORIGIN = 'https://app.example';

function request(path: string, init: { headers?: Record<string, string>; method?: string } = {}) {
  return new NextRequest(`${ORIGIN}${path}`, init);
}

function nonceOf(response: Response): string | undefined {
  return /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
}

describe('proxy: locale negotiation for unprefixed paths (P1-10)', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));
  afterEach(() => vi.unstubAllEnvs());

  it('redirects / to the default locale when nothing else is known', () => {
    const res = proxy(request('/'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/en`);
    expect(res.headers.get('vary')).toMatch(/Accept-Language, Cookie/);
    expect(nonceOf(res)).toBeDefined();
  });

  it.each([
    ['fa-IR,fa;q=0.9,en;q=0.5', 'fa'],
    ['fa', 'fa'],
    ['en-GB,en;q=0.8', 'en'],
    ['de-DE, fa;q=0.4', 'fa'],
    ['de-DE', 'en'],
    ['*', 'en'],
    ['not a language header ;;;', 'en'],
  ])('Accept-Language %j → /%s', (acceptLanguage, expected) => {
    const res = proxy(request('/', { headers: { 'accept-language': acceptLanguage } }));
    expect(res.headers.get('location')).toBe(`${ORIGIN}/${expected}`);
  });

  it('prefers the NEXT_LOCALE cookie (an explicit choice) over Accept-Language', () => {
    const res = proxy(
      request('/', { headers: { cookie: 'NEXT_LOCALE=fa', 'accept-language': 'en-US' } }),
    );
    expect(res.headers.get('location')).toBe(`${ORIGIN}/fa`);
  });

  it('ignores an unsupported cookie value', () => {
    const res = proxy(
      request('/', { headers: { cookie: 'NEXT_LOCALE=../de', 'accept-language': 'fa' } }),
    );
    expect(res.headers.get('location')).toBe(`${ORIGIN}/fa`);
  });

  it('keeps the path and query when adding the locale prefix', () => {
    const res = proxy(request('/pricing?plan=pro', { headers: { 'accept-language': 'fa' } }));
    expect(res.headers.get('location')).toBe(`${ORIGIN}/fa/pricing?plan=pro`);
  });

  it.each([
    '//evil',
    '//evil/x',
    '/\\evil',
    '/%5Cevil',
    '/%5C%5Cevil/x',
    '/%2F%2Fevil',
    '//evil.example/path',
    '/https:%2F%2Fevil',
    '/%09/evil',
  ])('never redirects off-origin: %s', (path) => {
    const res = proxy(request(path));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toMatch(/^\/en\/[^/]/);
  });
});

describe('proxy: prefixed pages keep the CSP nonce through i18n routing (P1-08 + P1-10)', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));
  afterEach(() => vi.unstubAllEnvs());

  it.each(['fa', 'en'] as const)(
    '/%s passes through with its locale and the nonce forwarded to rendering',
    (locale) => {
      const res = proxy(request(`/${locale}`, { headers: { 'accept-language': 'de' } }));
      expect(res.headers.get('location')).toBeNull();
      const nonce = nonceOf(res);
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      // Request headers Next.js renders with (NextResponse.next({ request: { headers } })).
      expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
      expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(
        res.headers.get('content-security-policy'),
      );
      expect(res.headers.get('x-middleware-request-x-next-intl-locale')).toBe(locale);
      // hreflang alternates for search engines.
      expect(res.headers.get('link')).toContain(`<${ORIGIN}/fa>; rel="alternate"; hreflang="fa"`);
      expect(res.headers.get('link')).toContain(`<${ORIGIN}/en>; rel="alternate"; hreflang="en"`);
    },
  );

  it('passes deeper prefixed paths through (unknown ones 404 in the app, localized)', () => {
    const res = proxy(request('/fa/does-not-exist'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-request-x-next-intl-locale')).toBe('fa');
  });

  // `Secure` is decided when the routing config loads (NODE_ENV=production under `next start`);
  // the route tests against the built app assert it.
  it('remembers a locale reached by URL in a cookie (lax, 1 year, readable by the switcher)', () => {
    const res = proxy(request('/fa', { headers: { 'accept-language': 'en' } }));
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^NEXT_LOCALE=fa;/);
    expect(cookie).toMatch(/Max-Age=31536000/);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).not.toMatch(/HttpOnly/); // the client-side switcher updates it
  });

  it('does not set the cookie when the URL locale is what Accept-Language already says', () => {
    const res = proxy(request('/fa', { headers: { 'accept-language': 'fa' } }));
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('gives every request a fresh nonce', () => {
    expect(nonceOf(proxy(request('/fa')))).not.toBe(nonceOf(proxy(request('/fa'))));
  });
});

describe('proxy: requests outside locale routing still get the CSP', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('does not prefix files', () => {
    for (const path of ['/robots.txt', '/manifest.webmanifest', '/fa/image.png']) {
      const res = proxy(request(path));
      expect(res.headers.get('location'), path).toBeNull();
      expect(res.headers.get('x-middleware-request-x-next-intl-locale'), path).toBeNull();
      expect(nonceOf(res), path).toBeDefined();
      expect(res.headers.get('x-middleware-request-x-nonce'), path).toBe(nonceOf(res));
    }
  });

  it('does not route non-navigation methods (Server Actions POST to prefixed pages)', () => {
    const res = proxy(request('/', { method: 'POST' }));
    expect(res.headers.get('location')).toBeNull();
    expect(nonceOf(res)).toBeDefined();
  });

  it('classifies requests', () => {
    const r = (path: string, method = 'GET') => ({ method, nextUrl: new URL(`${ORIGIN}${path}`) });
    expect(isLocalizedRequest(r('/'))).toBe(true);
    expect(isLocalizedRequest(r('/fa/habits'))).toBe(true);
    expect(isLocalizedRequest(r('/', 'HEAD'))).toBe(true);
    expect(isLocalizedRequest(r('/', 'POST'))).toBe(false);
    expect(isLocalizedRequest(r('/robots.txt'))).toBe(false);
    expect(isLocalizedRequest(r('/_next/data/x'))).toBe(false);
  });
});
