import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import type { Locale } from './env';

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
}

/**
 * The browser suite's `test`: every page records CSP violations from its first script on, and
 * after each test the page must have produced no CSP violation, no console error and no uncaught
 * error (refined criteria of #17, deferred from P1-08 and P1-11).
 */
export const test = base.extend<Options & { pageGuard: void }>({
  allowPageErrors: [false, { option: true }],
  pageGuard: [
    async ({ page, allowPageErrors }, use) => {
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
        if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
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
