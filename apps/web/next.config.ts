import type { NextConfig } from 'next';
import { defaultLocale } from './lib/i18n/config';
import { WEB_SECURITY_HEADERS } from './lib/security/headers';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@habit/ui'],
  async headers() {
    // Static security headers on every path (P1-08). The per-request CSP is set in proxy.ts.
    return [{ source: '/:path*', headers: [...WEB_SECURITY_HEADERS] }];
  },
  async redirects() {
    // Phase 0 stub: locale negotiation (Accept-Language / cookie) arrives with next-intl in Phase 1.
    return [{ source: '/', destination: `/${defaultLocale}`, permanent: false }];
  },
};

export default nextConfig;
