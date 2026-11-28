import { describe, expect, it } from 'vitest';
import { checkRequestOrigin, isUnsafeMethod } from './request-origin.js';

// Backlog P2-03 (ADR-0019): the origin layer of CSRF protection.
describe('checkRequestOrigin', () => {
  const trusted = new Set(['https://app.example.com', 'http://localhost:3000']);
  const check = (headers: Record<string, string>) => checkRequestOrigin({ headers }, trusted);

  it('accepts exactly the trusted origins', () => {
    expect(check({ origin: 'https://app.example.com' })).toBeNull();
    expect(check({ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' })).toBeNull();
  });

  it.each([
    ['sibling subdomain (same site)', 'https://evil.example.com'],
    ['parent domain', 'https://example.com'],
    ['scheme downgrade', 'http://app.example.com'],
    ['other port', 'http://localhost:3001'],
    ['suffix trick', 'https://app.example.com.attacker.net'],
    ['trailing slash', 'https://app.example.com/'],
    ['case variant', 'https://APP.example.com'],
  ])('rejects a %s', (_label, origin) => {
    expect(check({ origin })).toBe('origin-not-allowed');
  });

  it('rejects the opaque origin "null" (sandboxed frames, data: URLs)', () => {
    expect(check({ origin: 'null' })).toBe('origin-null');
  });

  it('without Origin, trusts only Sec-Fetch-Site: same-origin', () => {
    expect(check({ 'sec-fetch-site': 'same-origin' })).toBeNull();
    for (const site of ['same-site', 'cross-site', 'none']) {
      expect(check({ 'sec-fetch-site': site })).toBe('cross-site-fetch');
    }
  });

  it('lets non-browser requests (no Origin, no Sec-Fetch-Site) through this layer', () => {
    expect(check({})).toBeNull();
  });

  it('Origin wins over Sec-Fetch-Site', () => {
    expect(check({ origin: 'https://evil.example.com', 'sec-fetch-site': 'same-origin' })).toBe(
      'origin-not-allowed',
    );
  });
});

describe('isUnsafeMethod', () => {
  it('treats everything but GET, HEAD and OPTIONS as state-changing', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) expect(isUnsafeMethod(m)).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'post']) {
      expect(isUnsafeMethod(m)).toBe(true);
    }
  });
});
