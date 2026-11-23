import type { NextConfig } from 'next';
import { defaultLocale } from './lib/i18n/config';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@habit/ui'],
  async redirects() {
    // Phase 0 stub: locale negotiation (Accept-Language / cookie) arrives with next-intl in Phase 1.
    return [{ source: '/', destination: `/${defaultLocale}`, permanent: false }];
  },
};

export default nextConfig;
