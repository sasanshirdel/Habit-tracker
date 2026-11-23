import type { z } from 'zod';
import type { JobDefinition } from '../queue/job-definition.js';

export interface JobContext {
  readonly jobId: string;
  /** 1 for the first try, 2 for the first retry, … */
  readonly attempt: number;
  readonly maxAttempts: number;
}

/**
 * Consumer for one job type. Lives in the module that owns the work (ADR-0006) and is registered
 * in the worker through `JOB_HANDLERS`. Throwing makes BullMQ retry with the definition's backoff;
 * throw `UnrecoverableError` (from bullmq) for failures a retry cannot fix. Handlers must be
 * idempotent: a job can run more than once (retries, stalled-job recovery after a crash).
 */
export interface JobHandler<S extends z.ZodType = z.ZodType> {
  readonly definition: JobDefinition<S>;
  handle(payload: z.output<S>, context: JobContext): Promise<void>;
}

/** Injection token: the list of handlers the worker process consumes. */
export const JOB_HANDLERS = Symbol('JOB_HANDLERS');
