import { z } from 'zod';
import { defineJob } from '../../queue/job-definition.js';
import type { EmailSendLimits } from './verification-resend-throttle.js';

/**
 * Password recovery policy (backlog P2-05, ADR-0022). Interim values, reversible — listed as open
 * decisions for the owner in ADR-0022.
 */
export const PASSWORD_RESET_POLICY = {
  /** A reset link works once, for this long (OWASP: short-lived; 30 min fits "check mail now"). */
  tokenLifetimeMs: 30 * 60 * 1000,
  /** A reset email is sent to one address at most once per this many seconds… */
  requestCooldownSeconds: 60,
  /** …and at most this many times per hour, however often the public form is sent. */
  requestMaxPerHour: 5,
} as const;

/**
 * Policy name of the per-address limit on reset requests (Redis key part). The limit never shows
 * in a response — the request endpoint answers the same 202 whether or not an email goes out — so
 * it cannot reveal anything about the address either.
 */
export const PASSWORD_RESET_REQUEST_POLICY_NAME = 'password-reset';

export const PASSWORD_RESET_REQUEST_LIMITS: EmailSendLimits = {
  policy: PASSWORD_RESET_REQUEST_POLICY_NAME,
  cooldownMs: PASSWORD_RESET_POLICY.requestCooldownSeconds * 1000,
  maxPerHour: PASSWORD_RESET_POLICY.requestMaxPerHour,
};

const jobOptions = {
  // Delivery problems are usually transient: 5 tries over ~30 s (2, 4, 8, 16 s).
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2_000 },
};

/**
 * Worker job that emails a password-reset link. The payload follows the queue payload rule
 * (SECURITY.md): the account id only — never the address or the token, which the worker reads
 * from / writes to the database itself. Queued only for an existing, not deleted account; the
 * worker checks again (deleted in between → nothing).
 */
export const PASSWORD_RESET_EMAIL_JOB = defineJob({
  name: 'identity.password-reset-email',
  queue: 'email',
  schema: z.strictObject({ userId: z.uuid() }),
  options: jobOptions,
});

/**
 * Worker job that tells the account's address its password was just changed (after a reset), with
 * the way to react if it was not the owner. Payload: the account id only.
 */
export const PASSWORD_CHANGED_EMAIL_JOB = defineJob({
  name: 'identity.password-changed-email',
  queue: 'email',
  schema: z.strictObject({ userId: z.uuid() }),
  options: jobOptions,
});
