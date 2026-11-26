import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  API_SECURITY_HEADERS,
  corsDelegate,
  corsOptions,
  securityHeadersMiddleware,
} from './security-headers.js';

describe('API security headers (P1-08)', () => {
  it('pins the header set', () => {
    expect(API_SECURITY_HEADERS).toEqual({
      'Content-Security-Policy':
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-site',
      'Origin-Agent-Cluster': '?1',
      'X-DNS-Prefetch-Control': 'off',
      'X-Permitted-Cross-Domain-Policies': 'none',
      'X-Download-Options': 'noopen',
      'Cache-Control': 'no-store',
    });
    expect(Object.isFrozen(API_SECURITY_HEADERS)).toBe(true);
  });

  it('middleware sets every header and continues', () => {
    const set = new Map<string, string>();
    const res = { setHeader: (k: string, v: string) => set.set(k, v) } as unknown as ServerResponse;
    const next = vi.fn();
    securityHeadersMiddleware({} as IncomingMessage, res, next);
    expect(Object.fromEntries(set)).toEqual(API_SECURITY_HEADERS);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('corsOptions (P1-08)', () => {
  it('allows only the configured origins, with credentials and explicit lists', () => {
    const options = corsOptions(['https://app.example']);
    expect(options).toEqual({
      origin: ['https://app.example'],
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Accept', 'Accept-Language', 'Content-Type', 'X-Request-Id', 'X-CSRF-Token'],
      exposedHeaders: [
        'x-request-id',
        'Retry-After',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
      ],
      maxAge: 600,
      optionsSuccessStatus: 204,
    });
  });

  it('switches CORS off for any origin not on the list', () => {
    const delegate = corsDelegate(['https://app.example']);
    const decide = (origin?: string) => {
      let result: unknown;
      const headers = origin === undefined ? {} : { origin };
      delegate({ headers } as IncomingMessage, (_err, options) => (result = options));
      return result;
    };
    expect(decide('https://app.example')).toEqual(corsOptions(['https://app.example']));
    expect(decide('https://evil.example')).toEqual({ origin: false });
    expect(decide('https://app.example.evil.example')).toEqual({ origin: false });
    expect(decide('null')).toEqual({ origin: false });
    expect(decide(undefined)).toEqual({ origin: false });
  });
});
