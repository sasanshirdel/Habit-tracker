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

/**
 * The signed-in browser state the `setup` project creates (P2-09): one account, signed in once,
 * reused by every test that needs the app. Tests that sign in, sign out or rotate a session must
 * start from an empty state instead ({@link SIGNED_OUT}): signing in revokes the presented session
 * and signing out ends it, which would sign every other test out.
 */
export const STORAGE_STATE = `${import.meta.dirname}/../.auth/user.json`;
export const SHARED_ACCOUNT = `${import.meta.dirname}/../.auth/account.json`;
export const SIGNED_OUT = { cookies: [], origins: [] };

/**
 * Budget of the API's `auth` rate-limit class (10 requests per 5 minutes per address; ADR-0011)
 * that one run may spend: every register/login in the suite comes from 127.0.0.1. Each run gets
 * its own counter namespace (playwright.config.ts), so reruns do not add up; keep the suite at or
 * below this number (setup 2 + csrf 2 + auth journeys 5 = 9).
 */
export const E2E_AUTH_BUDGET = 9;
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
