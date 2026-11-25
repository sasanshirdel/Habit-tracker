/**
 * Security headers for the web app (backlog P1-08, ADR-0011).
 *
 * - The Content-Security-Policy is per request (a fresh nonce each time) and is set by `proxy.ts`;
 *   Next.js reads the nonce from the request's CSP header and puts it on its own scripts.
 * - Every other header is static and set for all paths in `next.config.ts` → `headers()`.
 *
 * Pure functions (no Next.js imports) so they are unit-tested and shared by both places.
 */

export interface CspOptions {
  /** Base64 nonce, unique per request. */
  nonce: string;
  /** `next dev` needs `'unsafe-eval'` (React debugging), inline styles and the HMR websocket. */
  isDev: boolean;
  /** Origins the browser may `fetch` besides its own (the API). */
  connectSrc?: readonly string[];
}

/**
 * Strict CSP: scripts only with this request's nonce (`'strict-dynamic'` lets those load their
 * chunks); no inline or injected scripts, no plugins, no framing, no foreign forms or base URL.
 * Styles: own stylesheets plus nonce'd `<style>` elements; inline `style="…"` attributes are
 * allowed (`style-src-attr`) because UI primitives position popovers with them (P1-09) and a
 * style attribute cannot run code. Development allows all inline styles (dev overlay, HMR).
 */
export function buildContentSecurityPolicy({ nonce, isDev, connectSrc = [] }: CspOptions): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error('CSP nonce must be base64.');
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`],
    'style-src-attr': ["'unsafe-inline'"],
    'img-src': ["'self'", 'blob:', 'data:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...connectSrc, ...(isDev ? ['ws:'] : [])],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'manifest-src': ["'self'"],
    'worker-src': ["'self'"],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (!isDev) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

/** 128-bit random nonce, base64 (Web Crypto: available in the Node.js and edge runtimes). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Origin of the API for `connect-src`, from `NEXT_PUBLIC_API_BASE_URL`. Returns nothing for a
 * missing or invalid value (then only same-origin requests are allowed — fail closed).
 */
export function apiOrigin(apiBaseUrl: string | undefined): string[] {
  if (!apiBaseUrl) return [];
  try {
    const url = new URL(apiBaseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? [url.origin] : [];
  } catch {
    return [];
  }
}

/** Static headers for every web response (set in `next.config.ts`). */
export const WEB_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = Object.freeze([
  // Browsers ignore HSTS on plain HTTP, so local development is unaffected.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Legacy equivalent of CSP frame-ancestors 'none'.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Origin-Agent-Cluster', value: '?1' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  // Powerful features off until a feature needs one (e.g. microphone for voice journal, P5).
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()',
  },
]);
