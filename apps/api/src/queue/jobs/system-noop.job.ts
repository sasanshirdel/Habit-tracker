import { z } from 'zod';
import { defineJob } from '../job-definition.js';

/**
 * Example job (backlog P1-03): does nothing except optionally wait, so the queue → worker path,
 * retries and graceful shutdown can be exercised end to end. Uses the default retry policy
 * (3 attempts, exponential backoff). The payload follows the queue payload rule: an identifier
 * and a bounded parameter, nothing else (strict — unknown fields are rejected).
 */
export const SYSTEM_NOOP_JOB = defineJob({
  name: 'system.noop',
  queue: 'system',
  schema: z.strictObject({
    /** Correlates producer and worker logs; not a user identifier. */
    correlationId: z.uuid(),
    /** Simulated work duration, at most 10 s. */
    workMs: z.int().min(0).max(10_000).default(0),
  }),
});
