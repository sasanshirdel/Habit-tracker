import { z } from 'zod';
import { component } from '../openapi/schema-registry.js';
import { errorEnvelopeWith } from '../openapi/common.schemas.js';

/**
 * Response schemas of the health probes, published in the OpenAPI document (P1-06). They mirror
 * `HealthResponse`, `ReadinessResponse` and `ReadinessErrorDetails` from `@habit/shared-types`;
 * `openapi.test.ts` asserts the types are equal and the e2e/integration tests parse real
 * responses with them.
 */

export const dependencyStatusSchema = component(z.enum(['up', 'down']), {
  id: 'DependencyStatus',
});

export const readinessChecksSchema = component(
  z.strictObject({ database: dependencyStatusSchema, redis: dependencyStatusSchema }),
  { id: 'ReadinessChecks' },
);

export const healthResponseSchema = component(
  z.strictObject({
    status: z.literal('ok'),
    uptimeSeconds: z.int().min(0),
    timestamp: z.iso.datetime().meta({ description: 'ISO 8601 instant (UTC).' }),
  }),
  { id: 'HealthResponse', description: 'Liveness: the process is up.' },
);

export const readinessResponseSchema = component(
  z.strictObject({
    status: z.literal('ok'),
    checks: readinessChecksSchema,
    timestamp: z.iso.datetime().meta({ description: 'ISO 8601 instant (UTC).' }),
  }),
  { id: 'ReadinessResponse', description: 'Every dependency needed to serve traffic is up.' },
);

export const readinessErrorDetailsSchema = component(
  z.strictObject({ checks: readinessChecksSchema }),
  { id: 'ReadinessErrorDetails' },
);

export const notReadyErrorSchema = component(
  errorEnvelopeWith(z.literal('NOT_READY'), readinessErrorDetailsSchema),
  { id: 'NotReadyError', description: '503 `NOT_READY`: at least one dependency is down.' },
);
