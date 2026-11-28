import createIntlMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { routing } from './lib/i18n/routing';
import { apiOrigin, buildContentSecurityPolicy, createNonce } from './lib/security/headers';

const handleI18nRouting = createIntlMiddleware(routing);

/**
 * The one request proxy of the web app (Next.js 16 `proxy.ts`). In order:
 *
 * 1. **Per-request Content-Security-Policy** with a fresh nonce (backlog P1-08, ADR-0011). The CSP
 *    goes on the request too: Next.js reads `'nonce-…'` from the request's CSP header while
 *    rendering and adds it to its framework scripts, so only those scripts run. Pages must render
 *    dynamically for this (a prerendered page has no nonce) — the locale layout opts in.
 * 2. **Locale routing** with next-intl (backlog P1-10, ADR-0004): unprefixed paths are redirected
 *    to the negotiated locale, prefixed ones pass through with the resolved locale. next-intl
 *    forwards the request headers it is given, so it receives the request *with* the nonce and
 *    CSP already set — the nonce reaches rendering on every path through the i18n middleware.
 *
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

  const response = isLocalizedRequest(request)
    ? handleI18nRouting(new NextRequest(request.url, { headers: requestHeaders }))
    : NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('Content-Security-Policy', csp);
  if (response.headers.has('location')) {
    // The locale redirect depends on the cookie and Accept-Language: caches must key on both.
    response.headers.append('Vary', 'Accept-Language, Cookie');
  }
  return response;
}

/**
 * Locale routing applies to page navigations only: `GET`/`HEAD` (Server Actions `POST` to
 * already-prefixed pages) and paths without a file extension (`/robots.txt` must not become
 * `/en/robots.txt`). `/api/…` is never a page: it belongs to the API (behind a reverse proxy, or
 * nowhere on this origin), so it answers a plain 404 here instead of a redirect to `/en/api/…`
 * that hid a missing `NEXT_PUBLIC_API_BASE_URL`. Everything else still gets the CSP.
 */
export function isLocalizedRequest(request: {
  method: string;
  nextUrl: { pathname: string };
}): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const { pathname } = request.nextUrl;
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  return !pathname.startsWith('/_next/') && !/\.[^/]*$/.test(pathname);
}

export const config = {
  matcher: [
    {
      // Documents only: not build assets, image optimisation or icons, and not prefetches (their
      // payload is not a document and reuses the page's nonce; their links are already
      // locale-prefixed).
      source: '/((?!_next/static|_next/image|favicon.ico|icon|apple-icon).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
