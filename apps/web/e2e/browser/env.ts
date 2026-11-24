/**
 * Where the browser suite runs (backlog P1-13). Fixed loopback ports keep the run deterministic:
 * the web app reaches the API through `NEXT_PUBLIC_API_BASE_URL`, which Next.js inlines at build
 * time, so the web build and this file must agree on the API's address. Build for the suite with
 * `pnpm --filter @habit/web build:e2e` (sets the variable to {@link E2E_API_BASE_URL}).
 */
export const E2E_WEB_PORT = 3100;
export const E2E_API_PORT = 4100;

export const E2E_WEB_ORIGIN = `http://127.0.0.1:${E2E_WEB_PORT}`;
export const E2E_API_ORIGIN = `http://127.0.0.1:${E2E_API_PORT}`;
export const E2E_API_BASE_URL = `${E2E_API_ORIGIN}/api/v1`;

/** Redis namespaces of the API under test, apart from development data and integration runs. */
export const E2E_RATE_LIMIT_PREFIX = 'habit:e2e:rl';
export const E2E_QUEUE_PREFIX = 'habit:e2e:q';

export const locales = ['fa', 'en'] as const;
export type Locale = (typeof locales)[number];
export const directionOf = { fa: 'rtl', en: 'ltr' } as const satisfies Record<Locale, string>;

/** The three viewports the shell is designed for (P1-11): phone, tablet (icon rail), desktop. */
export const viewports = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1366, height: 768 },
} as const;
export type ViewportName = keyof typeof viewports;
