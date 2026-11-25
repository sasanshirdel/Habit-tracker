import type { DefaultJobOptions } from 'bullmq';

/**
 * Queue names. One queue per kind of workload, so a slow workload (e.g. AI calls) cannot starve
 * another (e.g. notifications). New queues are added by the phase that needs them.
 */
export const QUEUE_NAMES = ['system'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * Defaults for every job (a job definition may override them):
 * - 3 attempts with exponential backoff starting at 1 s (1 s, 2 s between retries);
 * - completed jobs are kept briefly for inspection, failed jobs stay in the failed set for 7 days
 *   so they can be inspected and retried by an operator (Phase 10 system management).
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 5_000 },
} as const satisfies DefaultJobOptions;

/** Upper bound for adding a job, so a request never hangs on a stuck Redis. */
export const ENQUEUE_TIMEOUT_MS = 5_000;
