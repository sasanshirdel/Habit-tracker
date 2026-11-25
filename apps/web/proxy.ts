import { NextResponse, type NextRequest } from 'next/server';
import { apiOrigin, buildContentSecurityPolicy, createNonce } from './lib/security/headers';

/**
 * Per-request Content-Security-Policy with a fresh nonce (backlog P1-08, ADR-0011).
 *
 * The CSP goes on the request too: Next.js reads `'nonce-…'` from the request's CSP header while
 * rendering and adds it to its framework scripts, so only those scripts run. Pages must render
 * dynamically for this (a prerendered page has no nonce) — the locale layout opts in.
 * Static headers (HSTS, nosniff, …) are set for every path in `next.config.ts`.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    connectSrc: apiOrigin(process.env.NEXT_PUBLIC_API_BASE_URL),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Documents only: not build assets, image optimisation or icons, and not prefetches (their
      // payload is not a document and reuses the page's nonce).
      source: '/((?!_next/static|_next/image|favicon.ico|icon|apple-icon).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
