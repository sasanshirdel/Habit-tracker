import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { E2E_API_ORIGIN, E2E_OUTBOX_DIR, clientAddressFor, type Locale } from './env';

/** A CSP violation as the browser reported it (`securitypolicyviolation` event). */
export interface CspViolation {
  directive: string;
  blockedURI: string;
  sample: string;
}

type Messages = Record<string, Record<string, string>>;

/** The app's own messages, so assertions follow the copy instead of duplicating it. */
export function messages(locale: Locale): Messages {
  const file = join(import.meta.dirname, '..', '..', 'lib', 'i18n', 'messages', `${locale}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Messages;
}

/**
 * Violations recorded in the current document so far (the listener is installed before any page
 * script runs).
 */
export async function cspViolations(page: Page): Promise<CspViolation[]> {
  return page.evaluate(
    () => (window as unknown as { __cspViolations?: CspViolation[] }).__cspViolations ?? [],
  );
}

interface Options {
  /**
   * Tests that provoke violations on purpose (csp.spec.ts) turn the automatic "no CSP violations,
   * no console errors, no page errors" check off and assert on what they expect instead.
   */
  allowPageErrors: boolean;
  /**
   * Console errors a test expects, e.g. Chromium's "Failed to load resource: … 401" for the
   * session check on a signed-out page (P2-09). Matching messages are ignored; any other console
   * error still fails the test.
   */
  expectedConsoleErrors: RegExp[];
}

/** Chromium logs every 401 response as a console error; the signed-out session check answers 401. */
export const UNAUTHENTICATED_CONSOLE_ERROR =
  /Failed to load resource: the server responded with a status of 401/;

/**
 * The browser suite's `test`: every page records CSP violations from its first script on, and
 * after each test the page must have produced no CSP violation, no console error and no uncaught
 * error (refined criteria of #17, deferred from P1-08 and P1-11).
 */
export const test = base.extend<Options & { pageGuard: void }>({
  // Every API request of the test carries the test's own client address (P2-04, see
  // `clientAddressFor`), so per-address rate limits budget each test separately.
  // (`provide` rather than `use`: the React hooks lint rule would mistake it for React's `use`.)
  context: async ({ context }, provide, testInfo) => {
    await presentClientAddress(context, clientAddressFor(testInfo.testId));
    await provide(context);
  },
  allowPageErrors: [false, { option: true }],
  expectedConsoleErrors: [[], { option: true }],
  pageGuard: [
    async ({ page, allowPageErrors, expectedConsoleErrors }, use) => {
      // Every violation of every document the test visits reaches this list through a binding;
      // the init script and the binding go through the DevTools protocol, so the page's CSP does
      // not apply to them.
      const violations: CspViolation[] = [];
      await page.exposeFunction('__reportCspViolation', (violation: CspViolation) => {
        violations.push(violation);
      });
      await page.addInitScript(() => {
        const list: unknown[] = [];
        Object.defineProperty(window, '__cspViolations', { value: list });
        document.addEventListener('securitypolicyviolation', (event) => {
          const violation = {
            directive: event.effectiveDirective,
            blockedURI: event.blockedURI,
            sample: event.sample,
          };
          list.push(violation);
          void (
            window as unknown as { __reportCspViolation: (v: unknown) => Promise<void> }
          ).__reportCspViolation(violation);
        });
      });
      const problems: string[] = [];
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (expectedConsoleErrors.some((pattern) => pattern.test(text))) return;
        problems.push(`console.error: ${text}`);
      });
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));

      await use();

      if (allowPageErrors) return;
      expect(violations, 'no CSP violations').toEqual([]);
      expect(problems, 'no console errors or uncaught errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Opens a page of the signed-in app and waits until the auth gate let it through (P2-09): the
 * shell renders at once, the page content only after `GET /auth/session` answered.
 */
export async function openApp(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('[data-auth-gate]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/**
 * Adds `X-Forwarded-For: <address>` to every request the context sends to the API under test.
 * Applied below the page (request interception), so it does not change the page's own CORS
 * requests — the API trusts exactly one proxy hop in the suite (`TRUST_PROXY=1`).
 */
export async function presentClientAddress(
  context: BrowserContext,
  address: string,
): Promise<void> {
  await context.route(`${E2E_API_ORIGIN}/**`, (route) =>
    route.fallback({ headers: { ...route.request().headers(), 'x-forwarded-for': address } }),
  );
}

/** One email the worker under test wrote to the outbox (`MAIL_TRANSPORT=outbox`, P2-04). */
export interface OutboxEmail {
  to: string;
  subject: string;
  template: string;
  locale: string;
  text: string;
  html: string;
  date: string;
}

/** Emails to `address` so far, oldest first. */
export function outboxFor(address: string): OutboxEmail[] {
  let files: string[];
  try {
    files = readdirSync(E2E_OUTBOX_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((file) => JSON.parse(readFileSync(join(E2E_OUTBOX_DIR, file), 'utf8')) as OutboxEmail)
    .filter((email) => email.to === address.toLowerCase())
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Waits until `count` emails reached `address` (the worker sends them asynchronously). */
export async function waitForEmails(address: string, count = 1): Promise<OutboxEmail[]> {
  await expect
    .poll(() => outboxFor(address).length, { timeout: 15_000, message: `emails to ${address}` })
    .toBeGreaterThanOrEqual(count);
  return outboxFor(address);
}

/** The verification link in an email's plain-text part. */
export function verificationLinkIn(email: OutboxEmail): string {
  const match = /(https?:\/\/\S+\/auth\/verify-email#token=[A-Za-z0-9_-]{43})/.exec(email.text);
  if (!match) throw new Error(`no verification link in ${email.template}`);
  return match[1]!;
}
