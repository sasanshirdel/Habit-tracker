import { z } from 'zod';
import { defineJob } from '../../queue/job-definition.js';

/**
 * Email verification policy (backlog P2-04, ADR-0021). Interim values, reversible — listed as
 * open decisions for the owner in ADR-0021.
 */
export const EMAIL_VERIFICATION_POLICY = {
  /** A verification link works once, for this long. */
  tokenLifetimeMs: 24 * 60 * 60 * 1000,
  /** A signed-in user may ask for a new link at most once per this many seconds… */
  resendCooldownSeconds: 60,
  /** …and at most this many times per hour. */
  resendMaxPerHour: 5,
  /**
   * Registration emails (the verification link, or the "you already have an account" notice for
   * a taken address) are sent at most once per account per this window, however often someone
   * submits the sign-up form with that address — the form is public, so it must not become a way
   * to flood someone's inbox. Implemented as a deterministic job id per window.
   */
  registrationEmailWindowMs: 15 * 60 * 1000,
} as const;

/** `details.policy` of the 429 the resend endpoint answers when the user asks too often. */
export const VERIFICATION_EMAIL_POLICY_NAME = 'verification-email';

/**
 * Worker job that emails a verification link (or, for an already verified account reached through
 * the public sign-up form, a "someone tried to register with your address" notice). The payload
 * follows the queue payload rule (SECURITY.md): the account id and why the email was asked for —
 * never the address or the token, which the worker reads from / writes to the database itself.
 *
 * - `registration`: sign-up form. Unverified account → new link; verified → notice; deleted →
 *   nothing.
 * - `resend`: the signed-in user asked for a new link. Unverified → new link; otherwise nothing.
 */
export const VERIFICATION_EMAIL_JOB = defineJob({
  name: 'identity.verification-email',
  queue: 'email',
  schema: z.strictObject({
    userId: z.uuid(),
    reason: z.enum(['registration', 'resend']),
  }),
  options: {
    // Delivery problems are usually transient: 5 tries over ~30 s (2, 4, 8, 16 s).
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
  },
});

/** Idempotency key of the registration email for `userId` in the window containing `now`. */
export function registrationEmailJobId(userId: string, now = Date.now()): string {
  const window = Math.floor(now / EMAIL_VERIFICATION_POLICY.registrationEmailWindowMs);
  return `identity-registration-email-${userId}-${window}`;
}
