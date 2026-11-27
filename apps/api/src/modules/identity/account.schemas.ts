import { z } from 'zod';
import {
  CLIENT_BROWSERS,
  CLIENT_DEVICES,
  CLIENT_OSES,
  SECURITY_EVENT_RETENTION_DAYS,
  SECURITY_EVENT_TYPES,
} from '@habit/shared-types';
import { paginationQuerySchema } from '@habit/shared-validation';
import { component, errorEnvelopeWith, paginatedSchema } from '../../openapi/index.js';

/**
 * Schemas of the session-management and security-activity routes (backlog P2-08, ADR-0023).
 * Response schemas mirror `@habit/shared-types` (asserted in `account.test.ts`).
 */

/** Keyset cursor content of both lists: the id (UUIDv7) of the last row returned. */
export const idCursorSchema = z.strictObject({ id: z.uuid() });

export const accountListQuerySchema = z.strictObject(paginationQuerySchema.shape);
export type AccountListQuery = z.output<typeof accountListQuerySchema>;

export const sessionIdParamSchema = z.uuid().meta({
  description: 'Id of one of your sessions, from `GET /account/sessions`.',
});

const isoInstant = (description: string) => z.iso.datetime().meta({ description });

export const clientDescriptionSchema = component(
  z.strictObject({
    browser: z.enum(CLIENT_BROWSERS),
    os: z.enum(CLIENT_OSES),
    device: z.enum(CLIENT_DEVICES),
  }),
  {
    id: 'ClientDescription',
    description:
      'Coarse client description derived from the User-Agent at sign-in. No IP address, location, raw user agent or version is stored or returned.',
  },
);

export const accountSessionSchema = component(
  z.strictObject({
    id: z.uuid().meta({ description: 'Opaque session id (not the session token).' }),
    current: z.boolean().meta({ description: '`true` for the session that made this request.' }),
    client: clientDescriptionSchema,
    createdAt: isoInstant('When the user signed in (UTC).'),
    lastActiveAt: isoInstant('Last request seen, accurate to about a minute (UTC).'),
    expiresAt: isoInstant('Latest possible end of the session (UTC).'),
  }),
  { id: 'AccountSession', description: 'An active session of the signed-in user.' },
);

export const accountSessionListSchema = component(paginatedSchema(accountSessionSchema), {
  id: 'AccountSessionList',
  description: 'Active sessions (not signed out, not expired), newest sign-in first.',
});

export const revokeOtherSessionsResponseSchema = component(
  z.strictObject({
    revoked: z.int().min(0).meta({ description: 'How many sessions were ended.' }),
  }),
  { id: 'RevokeOtherSessionsResponse' },
);

export const securityEventSchema = component(
  z.strictObject({
    id: z.uuid(),
    type: z.enum(SECURITY_EVENT_TYPES),
    occurredAt: isoInstant('When it happened (UTC).'),
    client: clientDescriptionSchema,
  }),
  { id: 'SecurityEvent', description: 'One entry of the signed-in user’s security activity.' },
);

export const securityEventListSchema = component(paginatedSchema(securityEventSchema), {
  id: 'SecurityEventList',
  description: `Security activity of the last ${SECURITY_EVENT_RETENTION_DAYS} days, newest first.`,
});

export const sessionNotFoundErrorSchema = component(
  errorEnvelopeWith(z.literal('NOT_FOUND'), z.unknown().optional()),
  {
    id: 'NotFoundError',
    description:
      '404 `NOT_FOUND`: no such resource of yours — identical for one that does not exist, has ended or belongs to someone else.',
  },
);
