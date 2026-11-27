import { z } from 'zod';

/**
 * Credential input rules (backlog P2-02, ADR-0018). The API validates with these schemas; the web
 * forms (P2-09) reuse them for immediate feedback only — the server stays the authority.
 */

/** RFC 5321 path limit; mirrored by the `users_email_check` constraint (ADR-0017). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Password length bounds in Unicode code points, measured after NFKC normalisation.
 *
 * - Minimum 8: OWASP ASVS 5.0 §6.2.1 floor (15 is "strongly recommended"; the owner may raise it,
 *   see ADR-0018 open decisions). No composition rules (upper/lower/digit/symbol): NIST SP 800-63B
 *   and ASVS advise against them.
 * - Maximum 128: ASVS allows rejecting anything longer; it bounds the work done per request.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Hard cap on the raw string (UTF-16 code units) before any normalisation work. 128 code points
 * need at most 256 UTF-16 units; NFKC can expand a string, so the cap leaves headroom while still
 * refusing megabyte-sized "passwords" before they are normalised or hashed.
 */
export const PASSWORD_INPUT_MAX_LENGTH = 1024;

/**
 * Canonical form of a password before it is checked or hashed: Unicode NFKC, as NIST SP 800-63B
 * recommends, so the same password typed on different keyboards/platforms (composed vs decomposed
 * characters, full-width forms) hashes identically. Nothing else is changed — no trimming, no
 * case folding, no truncation.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/** Number of Unicode code points (what users perceive as characters, roughly). */
function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

/**
 * An email address as the API stores and compares it: surrounding whitespace removed, lower-cased
 * (the column is `citext`, so this is exactly the equality the database applies — ADR-0017), then
 * syntax-checked with zod's email pattern (ASCII addresses; internationalised addresses are not
 * accepted yet) and bounded to {@link EMAIL_MAX_LENGTH}. Provider-specific rewriting (Gmail dots,
 * `+tags`) is deliberately **not** applied: they are different addresses as far as we know.
 */
export const emailAddressSchema = z
  .string()
  .max(1024)
  .trim()
  .toLowerCase()
  .pipe(z.email().max(EMAIL_MAX_LENGTH));

/**
 * A password chosen by the user (registration; later password reset/change). Output is the
 * NFKC-normalised password. Length issues use zod's `too_small`/`too_big` codes so clients can
 * localise them; the value itself never appears in an issue.
 */
export const newPasswordSchema = z
  .string()
  .max(PASSWORD_INPUT_MAX_LENGTH)
  .transform(normalizePassword)
  .superRefine((value, ctx) => {
    const length = codePointLength(value);
    if (length < PASSWORD_MIN_LENGTH) {
      ctx.addIssue({
        code: 'too_small',
        origin: 'string',
        minimum: PASSWORD_MIN_LENGTH,
        inclusive: true,
        message: `Must be at least ${PASSWORD_MIN_LENGTH} characters`,
      });
    } else if (length > PASSWORD_MAX_LENGTH) {
      ctx.addIssue({
        code: 'too_big',
        origin: 'string',
        maximum: PASSWORD_MAX_LENGTH,
        inclusive: true,
        message: `Must be at most ${PASSWORD_MAX_LENGTH} characters`,
      });
    }
  });

/**
 * A password presented at sign-in. Only bounded (not policy-checked): an account's password was
 * valid under the policy in force when it was set, and a wrong-length password simply fails to
 * match. Output is NFKC-normalised, like {@link newPasswordSchema}.
 */
export const currentPasswordSchema = z
  .string()
  .min(1)
  .max(PASSWORD_INPUT_MAX_LENGTH)
  .transform(normalizePassword);

/**
 * The credentials of the sign-in form and of `POST /auth/login` (P2-09): email + current
 * password. The API's `loginBodySchema` is this shape made strict; the web form validates with it
 * for immediate feedback only. Non-strict here so a form can carry UI-only fields.
 */
export const signInCredentialsSchema = z.object({
  email: emailAddressSchema,
  password: currentPasswordSchema,
});
export type SignInCredentials = z.output<typeof signInCredentialsSchema>;

/**
 * The credentials of the sign-up form and of `POST /auth/register` (P2-09): email + a password
 * that meets the policy. The API's `registerBodySchema` adds locale, time zone and display name.
 */
export const signUpCredentialsSchema = z.object({
  email: emailAddressSchema,
  password: newPasswordSchema,
});
export type SignUpCredentials = z.output<typeof signUpCredentialsSchema>;

/**
 * How long an emailed password-reset link works, in minutes (P2-05, ADR-0022; interim, owner may
 * change it). The API's token lifetime and the web page's "the link works for N minutes" both read
 * it.
 */
export const PASSWORD_RESET_LINK_MINUTES = 30;

/**
 * The forgot-password form and `POST /auth/password-reset/request` (backlog P2-05, ADR-0022): the
 * address to send a reset link to. Same normalisation as sign-in, so the per-address limit and the
 * account lookup see the address the way the database compares it.
 */
export const passwordResetRequestSchema = z.object({ email: emailAddressSchema });
export type PasswordResetRequestInput = z.output<typeof passwordResetRequestSchema>;

/**
 * The new password of the reset-password form and of `POST /auth/password-reset/confirm`
 * (P2-05): the same policy as registration ({@link newPasswordSchema}). The API's body adds the
 * token; the web form adds a "repeat the password" field checked in the browser only.
 */
export const passwordResetSchema = z.object({ password: newPasswordSchema });
export type PasswordResetInput = z.output<typeof passwordResetSchema>;
