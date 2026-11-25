import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import { config as proxyConfig, proxy } from '../../proxy';
import {
  WEB_SECURITY_HEADERS,
  apiOrigin,
  buildContentSecurityPolicy,
  createNonce,
} from './headers';

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
const directives = (csp: string) =>
  Object.fromEntries(
    csp.split('; ').map((d) => {
      const [name = '', ...values] = d.split(' ');
      return [name, values];
    }),
  );

describe('buildContentSecurityPolicy (P1-08)', () => {
  it('production: scripts only with the nonce, no inline/eval, nothing framed or plugged in', () => {
    const csp = buildContentSecurityPolicy({
      nonce: NONCE,
      isDev: false,
      connectSrc: ['https://api.example'],
    });
    const d = directives(csp);
    expect(d['script-src']).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(d['style-src']).toEqual(["'self'", `'nonce-${NONCE}'`]);
    expect(d['style-src-attr']).toEqual(["'unsafe-inline'"]);
    expect(d['connect-src']).toEqual(["'self'", 'https://api.example']);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['upgrade-insecure-requests']).toEqual([]);
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(d['script-src']).not.toContain("'unsafe-inline'");
  });

  it('development: adds eval, inline styles and the HMR websocket only there', () => {
    const d = directives(buildContentSecurityPolicy({ nonce: NONCE, isDev: true }));
    expect(d['script-src']).toContain("'unsafe-eval'");
    expect(d['script-src']).not.toContain("'unsafe-inline'");
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d['connect-src']).toEqual(["'self'", 'ws:']);
    expect(d['upgrade-insecure-requests']).toBeUndefined();
  });

  it('refuses a nonce that could break out of the header', () => {
    expect(() => buildContentSecurityPolicy({ nonce: "x'; script-src *", isDev: false })).toThrow(
      /nonce/,
    );
    expect(() => buildContentSecurityPolicy({ nonce: 'short', isDev: false })).toThrow(/nonce/);
  });
});

describe('createNonce', () => {
  it('returns 128 random bits as base64, different every time', () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(a);
  });
});

describe('apiOrigin', () => {
  it('reduces NEXT_PUBLIC_API_BASE_URL to its origin and fails closed on bad values', () => {
    expect(apiOrigin('http://localhost:4000/api/v1')).toEqual(['http://localhost:4000']);
    expect(apiOrigin('https://api.example/api/v1')).toEqual(['https://api.example']);
    expect(apiOrigin(undefined)).toEqual([]);
    expect(apiOrigin('not a url')).toEqual([]);
    expect(apiOrigin('javascript:alert(1)')).toEqual([]);
  });
});

describe('proxy (per-request CSP)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('sets a fresh nonce CSP on the response and passes it to rendering', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example/api/v1');
    const first = proxy(new NextRequest('https://app.example/fa'));
    const second = proxy(new NextRequest('https://app.example/fa'));
    const csp = first.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(csp).toContain("connect-src 'self' https://api.example");
    expect(csp).not.toMatch(/unsafe-eval/);
    // Next.js reads the nonce from the forwarded request headers.
    expect(first.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    expect(second.headers.get('content-security-policy')).not.toBe(csp);
  });

  it('skips static assets and prefetches', () => {
    const [matcher] = proxyConfig.matcher;
    const source = new RegExp(`^${matcher?.source ?? ''}$`);
    expect(source.test('/fa')).toBe(true);
    expect(source.test('/en/anything')).toBe(true);
    expect(source.test('/_next/static/chunks/main.js')).toBe(false);
    expect(source.test('/favicon.ico')).toBe(false);
    expect(matcher?.missing.map((m) => m.key)).toEqual(['next-router-prefetch', 'purpose']);
  });
});

describe('next.config headers', () => {
  it('sends the static security headers on every path', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toEqual([{ source: '/:path*', headers: [...WEB_SECURITY_HEADERS] }]);
    const keys = WEB_SECURITY_HEADERS.map((h) => h.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'Strict-Transport-Security',
        'X-Content-Type-Options',
        'X-Frame-Options',
        'Referrer-Policy',
        'Permissions-Policy',
      ]),
    );
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
