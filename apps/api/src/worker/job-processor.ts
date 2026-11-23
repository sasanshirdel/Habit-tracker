import { UnrecoverableError, type Job } from 'bullmq';
import type { JobHandler } from './job-handler.js';

/** Reasons a job is failed without retry (stored as the job's `failedReason`). */
export const JOB_REJECTION = {
  unknownJob: 'UNKNOWN_JOB',
  invalidPayload: 'INVALID_JOB_PAYLOAD',
} as const;

/** Indexes handlers by job name; a duplicate name is a programming error caught at startup. */
export function indexHandlers(handlers: readonly JobHandler[]): Map<string, JobHandler> {
  const byName = new Map<string, JobHandler>();
  for (const handler of handlers) {
    if (byName.has(handler.definition.name)) {
      throw new Error(`Duplicate job handler for "${handler.definition.name}"`);
    }
    byName.set(handler.definition.name, handler);
  }
  return byName;
}

type ProcessableJob = Pick<Job, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts'>;

/**
 * BullMQ processor for one queue: routes a job to its handler after re-validating the payload.
 * Unknown job names and invalid payloads fail immediately (`UnrecoverableError`, no retries) —
 * retrying cannot fix them. Errors thrown by handlers propagate so BullMQ retries with backoff.
 */
export function createJobProcessor(handlers: ReadonlyMap<string, JobHandler>) {
  return async (job: ProcessableJob): Promise<void> => {
    const handler = handlers.get(job.name);
    if (!handler) throw new UnrecoverableError(JOB_REJECTION.unknownJob);
    const parsed = handler.definition.schema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError(JOB_REJECTION.invalidPayload);
    await handler.handle(parsed.data, {
      jobId: job.id ?? '',
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? 1,
    });
  };
}
