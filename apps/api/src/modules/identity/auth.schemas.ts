import { z } from 'zod';
import {
  currentPasswordSchema,
  emailAddressSchema,
  localeSchema,
  newPasswordSchema,
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

export const registerBodySchema = z.strictObject({
  email: emailAddressSchema.meta({
    description: 'Trimmed and lower-cased before use. At most 254 characters.',
  }),
  password: newPasswordSchema.meta({
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
  email: emailAddressSchema,
  password: currentPasswordSchema.meta({
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
