import { z } from 'zod';
import {
  localeSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  signInCredentialsSchema,
  signUpCredentialsSchema,
  timeZoneSchema,
} from '@habit/shared-validation';
import { component, errorEnvelopeWith } from '../../openapi/index.js';
import { IDENTITY_LIMITS } from './identity.constants.js';

/**
 * Request and response schemas of the auth routes (backlog P2-02, ADR-0018). Request schemas are
 * strict (unknown fields → 400) and are documented inline by the OpenAPI generator; response
 * schemas are named components and mirror the types in `@habit/shared-types` (asserted in
 * `auth.test.ts`).
 */

// Email and password rules come from the shared credential schemas, which the web forms (P2-09)
// validate with too: one definition of what the server accepts.
export const registerBodySchema = z.strictObject({
  email: signUpCredentialsSchema.shape.email.meta({
    description: 'Trimmed and lower-cased before use. At most 254 characters.',
  }),
  password: signUpCredentialsSchema.shape.password.meta({
    description:
      '8–128 characters (Unicode code points after NFKC normalisation). No composition rules.',
  }),
  locale: localeSchema.meta({ description: 'Language the user registered in (`en` or `fa`).' }),
  timezone: timeZoneSchema.meta({ description: 'IANA time zone, e.g. `Asia/Tehran`.' }),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(IDENTITY_LIMITS.displayNameMaxLength)
    .optional()
    .meta({ description: 'Optional, 1–100 characters after trimming.' }),
});
export type RegisterInput = z.output<typeof registerBodySchema>;

export const loginBodySchema = z.strictObject({
  email: signInCredentialsSchema.shape.email,
  password: signInCredentialsSchema.shape.password.meta({
    description: 'The account password (not policy-checked).',
  }),
});
export type LoginInput = z.output<typeof loginBodySchema>;

export const registrationAcceptedResponseSchema = component(
  z.strictObject({ status: z.literal('accepted') }),
  {
    id: 'RegistrationAcceptedResponse',
    description:
      'Same answer whether or not the address was already registered. No session is created; sign in next.',
  },
);

export const authenticatedUserSchema = component(
  z.strictObject({
    id: z.uuid().meta({ description: 'Opaque user id (UUIDv7).' }),
    email: z.string(),
    emailVerified: z.boolean(),
  }),
  { id: 'AuthenticatedUser' },
);

const csrfTokenSchema = z.string().meta({
  description:
    'CSRF token of this session (ADR-0019). Keep it in memory only; send it as `X-CSRF-Token` on ' +
    'every POST/PUT/PATCH/DELETE.',
});

export const loginResponseSchema = component(
  z.strictObject({ user: authenticatedUserSchema, csrfToken: csrfTokenSchema }),
  {
    id: 'LoginResponse',
    description: 'The session is in the `__Host-session` cookie (`HttpOnly`), never in the body.',
  },
);

export const sessionResponseSchema = component(
  z.strictObject({ user: authenticatedUserSchema, csrfToken: csrfTokenSchema }),
  {
    id: 'SessionResponse',
    description: 'The signed-in account and the CSRF token of the presented session.',
  },
);

export const invalidCredentialsErrorSchema = component(
  errorEnvelopeWith(z.literal('INVALID_CREDENTIALS'), z.unknown().optional()),
  {
    id: 'InvalidCredentialsError',
    description:
      '401 `INVALID_CREDENTIALS`: identical for an unknown address and a wrong password.',
  },
);

// --- Email verification (P2-04, ADR-0021) ---

export const confirmEmailBodySchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .max(128)
    .meta({
      description:
        'The token from the emailed link (`…/auth/verify-email#token=…`). Malformed, unknown, ' +
        'expired, used and superseded tokens all get the same 400 `INVALID_TOKEN`.',
    }),
});
export type ConfirmEmailInput = z.output<typeof confirmEmailBodySchema>;

export const emailVerifiedResponseSchema = component(
  z.strictObject({ status: z.literal('verified') }),
  { id: 'EmailVerifiedResponse', description: 'The address the link was sent to is verified.' },
);

export const verificationEmailAcceptedResponseSchema = component(
  z.strictObject({ status: z.literal('accepted') }),
  {
    id: 'VerificationEmailAcceptedResponse',
    description:
      'A new link will be emailed unless the address is already verified; earlier links stop working.',
  },
);

export const invalidTokenErrorSchema = component(
  errorEnvelopeWith(z.literal('INVALID_TOKEN'), z.unknown().optional()),
  {
    id: 'InvalidTokenError',
    description:
      '400 `INVALID_TOKEN`: the link is unknown, malformed, expired, already used or superseded by a newer one — indistinguishable on purpose.',
  },
);

// --- Password recovery (P2-05, ADR-0022) ---

export const passwordResetRequestBodySchema = z.strictObject({
  email: passwordResetRequestSchema.shape.email.meta({
    description: 'Trimmed and lower-cased before use. At most 254 characters.',
  }),
});
export type PasswordResetRequestBody = z.output<typeof passwordResetRequestBodySchema>;

export const passwordResetAcceptedResponseSchema = component(
  z.strictObject({ status: z.literal('accepted') }),
  {
    id: 'PasswordResetAcceptedResponse',
    description:
      'Same answer for every well-formed address — registered or not, deleted, or asked for too often. If the address belongs to an account, a reset link is on its way.',
  },
);

export const passwordResetConfirmBodySchema = z.strictObject({
  token: confirmEmailBodySchema.shape.token.meta({
    description:
      'The token from the emailed link (`…/auth/reset-password#token=…`). Malformed, unknown, ' +
      'expired, used and superseded tokens all get the same 400 `INVALID_TOKEN`.',
  }),
  password: passwordResetSchema.shape.password.meta({
    description:
      'The new password: 8–128 characters (Unicode code points after NFKC normalisation), like ' +
      'registration. A policy violation is 400 `VALIDATION_FAILED` and leaves the link usable.',
  }),
});
export type PasswordResetConfirmBody = z.output<typeof passwordResetConfirmBodySchema>;

export const passwordResetResponseSchema = component(
  z.strictObject({ status: z.literal('password-reset') }),
  {
    id: 'PasswordResetResponse',
    description:
      'The new password is set; every session of the account has ended (sign in again — this response does not sign in) and the address counts as verified.',
  },
);
