import type { JobsOptions } from 'bullmq';
import type { z } from 'zod';
import type { QueueName } from './queue.constants.js';

/**
 * A job type: its name, the queue it runs on, the schema of its payload and optional per-job
 * options. The schema is enforced twice — by the producer before enqueueing and by the worker
 * before handling — so a job written by an older/newer release or by hand cannot reach a handler
 * with an unexpected shape.
 *
 * Payload rule (SECURITY.md): payloads carry **identifiers and small parameters only**, never
 * personal or sensitive content (journal text, emails, tokens). Handlers load what they need from
 * the database. Use strict object schemas so extra fields are rejected.
 */
export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  /** Stable, dotted, owned by one module: `<module>.<action>`, e.g. `system.noop`. */
  readonly name: string;
  readonly queue: QueueName;
  readonly schema: S;
  /** Overrides for `DEFAULT_JOB_OPTIONS` (attempts, backoff, retention, …). */
  readonly options?: Omit<JobsOptions, 'jobId' | 'delay' | 'repeat' | 'parent'>;
}

/** What a producer passes (schema input, before defaults). */
export type JobInput<D extends JobDefinition> = z.input<D['schema']>;
/** What a handler receives (schema output, after defaults). */
export type JobPayload<D extends JobDefinition> = z.output<D['schema']>;

export function defineJob<S extends z.ZodType>(definition: JobDefinition<S>): JobDefinition<S> {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(definition.name)) {
    throw new Error(`Invalid job name "${definition.name}" (expected <module>.<action>)`);
  }
  return Object.freeze(definition);
}
