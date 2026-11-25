import { z } from 'zod';
import { component } from './schema-registry.js';

/**
 * zod mirrors of the platform response contracts in `@habit/shared-types` (ADR-0009), published
 * as OpenAPI components (P1-06, ADR-0012). The TypeScript interfaces stay the source the web app
 * imports; `openapi.test.ts` asserts each schema's output type equals its interface, so the two
 * cannot drift silently.
 */

/** Every `ApiErrorCode`. Adding one is compatible; renaming or removing one is breaking. */
export const apiErrorCodeSchema = component(
  z.enum([
    'BAD_REQUEST',
    'VALIDATION_FAILED',
    'INVALID_CURSOR',
    'MALFORMED_REQUEST_BODY',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'METHOD_NOT_ALLOWED',
    'CONFLICT',
    'PAYLOAD_TOO_LARGE',
    'UNSUPPORTED_MEDIA_TYPE',
    'RATE_LIMITED',
    'INTERNAL_ERROR',
    'NOT_READY',
    'SERVICE_UNAVAILABLE',
    'QUEUE_UNAVAILABLE',
  ]),
  {
    id: 'ApiErrorCode',
    description:
      'Stable machine-readable error code. Clients localise by code; `message` is developer-facing English.',
  },
);

/** Builds an error envelope schema `{ error: { code, message, details?, requestId } }`. */
export function errorEnvelopeWith<C extends z.ZodType, D extends z.ZodType>(code: C, details: D) {
  return z.strictObject({
    error: z.strictObject({
      code,
      message: z.string().meta({
        description: 'Developer-facing summary (English); never shown to end users as-is.',
      }),
      details,
      requestId: z
        .string()
        .meta({ description: 'Same value as the `x-request-id` response header.' }),
    }),
  });
}

export const apiErrorSchema = component(
  errorEnvelopeWith(apiErrorCodeSchema, z.unknown().optional()),
  {
    id: 'ApiError',
    description: 'Error envelope returned by every failing request (ADR-0009).',
  },
);

export const validationIssueSchema = component(
  z.strictObject({
    field: z
      .string()
      .meta({ description: '`body`, `query` or `param`, then the dotted path, e.g. `body.name`.' }),
    code: z.string().meta({
      description: 'zod issue code, e.g. `too_small`, `invalid_type`, `unrecognized_keys`.',
    }),
    message: z.string(),
  }),
  {
    id: 'ValidationIssue',
    description: 'One field-level problem. Never contains the rejected value.',
  },
);

export const validationErrorDetailsSchema = component(
  z.strictObject({ issues: z.array(validationIssueSchema) }),
  { id: 'ValidationErrorDetails' },
);

export const validationFailedErrorSchema = component(
  errorEnvelopeWith(z.literal('VALIDATION_FAILED'), validationErrorDetailsSchema),
  { id: 'ValidationFailedError', description: '400 `VALIDATION_FAILED`.' },
);

export const rateLimitErrorDetailsSchema = component(
  z.strictObject({
    retryAfterSeconds: z
      .int()
      .min(1)
      .meta({ description: 'Same value as the `Retry-After` header.' }),
    policy: z
      .string()
      .meta({ description: 'Exceeded policy class name(s), comma-separated, e.g. `auth`.' }),
  }),
  { id: 'RateLimitErrorDetails' },
);

export const rateLimitedErrorSchema = component(
  errorEnvelopeWith(z.literal('RATE_LIMITED'), rateLimitErrorDetailsSchema),
  { id: 'RateLimitedError', description: '429 `RATE_LIMITED`.' },
);

export const pageInfoSchema = component(
  z.strictObject({
    nextCursor: z.string().nullable().meta({
      description: 'Opaque cursor for the next page (`?cursor=`); `null` on the last page.',
    }),
    hasMore: z.boolean(),
    limit: z.int().min(1).meta({ description: 'The page size that was applied.' }),
  }),
  { id: 'PageInfo' },
);

/**
 * Response schema of a cursor-paginated list (`Paginated<T>`, ADR-0009). The item schema should be
 * a registered component so the list references it.
 */
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ data: z.array(item), page: pageInfoSchema });
}
