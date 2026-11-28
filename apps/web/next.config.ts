import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { loadRepositoryEnv, sameOriginApiWarning } from './lib/config/repository-env';
import { WEB_SECURITY_HEADERS } from './lib/security/headers';

// The repository-root `.env` (from `.env.example`) — the one file the README tells developers to
// create — so `NEXT_PUBLIC_API_BASE_URL` reaches the build; real env and `apps/web/.env*` still win.
// Must run before the build inlines `NEXT_PUBLIC_*` values (next.config.ts is loaded first).
loadRepositoryEnv(import.meta.dirname);
const apiWarning = sameOriginApiWarning();
if (apiWarning) console.warn(apiWarning);

// Points next-intl at the per-request config (locale, messages, formats). The message extractor
// is not enabled, so its file watcher (@parcel/watcher) is never loaded (P1-10, ADR-0004).
const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@habit/ui'],
  async headers() {
    // Static security headers on every path (P1-08). The per-request CSP is set in proxy.ts.
    return [{ source: '/:path*', headers: [...WEB_SECURITY_HEADERS] }];
  },
  // No redirect for `/`: proxy.ts negotiates the locale (cookie → Accept-Language → default).
};

export default withNextIntl(nextConfig);
