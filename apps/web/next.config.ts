import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { WEB_SECURITY_HEADERS } from './lib/security/headers';

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
