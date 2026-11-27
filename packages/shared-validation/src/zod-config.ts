import { z } from 'zod';

/**
 * Zod settings that must be in place before any schema is built — `index.ts` imports this module
 * first (P2-09).
 *
 * In browsers, zod 4 probes whether `new Function` is allowed the first time it builds an object
 * schema, to compile a faster parser. The web app's CSP has no `'unsafe-eval'` (ADR-0011), so the
 * probe fails — harmlessly, but the browser still reports a `securitypolicyviolation` for it,
 * which pollutes CSP reporting and fails the browser suite's CSP guard. `jitless` skips the probe
 * and the compiled fast path; parsing results are identical. Servers (the API) keep the JIT.
 */
if (typeof (globalThis as { document?: unknown }).document !== 'undefined') {
  z.config({ jitless: true });
}
