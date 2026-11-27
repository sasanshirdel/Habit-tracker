import { z } from 'zod';
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  USER_DATA_EXPORT_FORMAT,
  USER_DATA_EXPORT_VERSION,
} from '@habit/shared-types';
import { accountDeletionSchema } from '@habit/shared-validation';
import { component, errorEnvelopeWith } from '../../openapi/index.js';
import { confirmEmailBodySchema } from './auth.schemas.js';

/**
 * Schemas of the data export, account deletion and restore routes (backlog P2-10, ADR-0025).
 * Request bodies are strict; responses mirror `@habit/shared-types` (asserted in `privacy.test.ts`).
 */

export const userDataExportSchema = component(
  z.strictObject({
    format: z.literal(USER_DATA_EXPORT_FORMAT),
    version: z.literal(USER_DATA_EXPORT_VERSION),
    exportedAt: z.iso.datetime().meta({ description: 'When the copy was made (UTC).' }),
    sections: z.record(z.string(), z.unknown()).meta({
      description:
        'One entry per feature module. `account` (identity): `user`, `password` (whether one is ' +
        'set and when it changed — never the hash), `profile`, `preferences`, `sessions` (signed-in ' +
        'devices incl. ended ones, coarse client only), `securityEvents`, `emailLinks` (emailed ' +
        'verification/reset/restore links: purpose and dates — never the token). Habits, goals and ' +
        'other modules add their own sections as they are built.',
    }),
  }),
  {
    id: 'UserDataExport',
    description:
      'Everything stored about the signed-in user, as one JSON document (a consistent snapshot).',
  },
);

export const accountDeletionBodySchema = z.strictObject({
  password: accountDeletionSchema.shape.password.meta({
    description: 'Your current password (re-authentication). Not policy-checked.',
  }),
});
export type AccountDeletionBody = z.output<typeof accountDeletionBodySchema>;

export const accountDeletionResponseSchema = component(
  z.strictObject({
    status: z.literal('deletion-scheduled'),
    purgeAfter: z.iso.datetime().meta({
      description: `When the account is erased for good (${ACCOUNT_DELETION_GRACE_DAYS} days after deletion) unless restored before.`,
    }),
  }),
  {
    id: 'AccountDeletionResponse',
    description:
      'The account is deleted and every session has ended (this response clears the cookie). A restore link is emailed.',
  },
);

export const reauthenticationFailedErrorSchema = component(
  errorEnvelopeWith(z.literal('REAUTHENTICATION_FAILED'), z.unknown().optional()),
  {
    id: 'ReauthenticationFailedError',
    description:
      '403 `REAUTHENTICATION_FAILED`: the password does not match the signed-in account. Repeated failures lock it like sign-in (429 `RATE_LIMITED`, `policy: "login-account"`).',
  },
);

export const accountRestoreBodySchema = z.strictObject({
  token: confirmEmailBodySchema.shape.token.meta({
    description:
      'The token from the emailed link (`…/auth/restore-account#token=…`). Malformed, unknown, ' +
      'expired, used and superseded tokens, and accounts that are not deleted, all get the same ' +
      '400 `INVALID_TOKEN`.',
  }),
});
export type AccountRestoreBody = z.output<typeof accountRestoreBodySchema>;

export const accountRestoreResponseSchema = component(
  z.strictObject({ status: z.literal('restored') }),
  {
    id: 'AccountRestoreResponse',
    description:
      'The account is restored. No session is created: sign in with your password (devices signed out at deletion stay signed out).',
  },
);
