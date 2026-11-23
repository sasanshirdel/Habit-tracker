import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Context of the background job being processed (backlog P1-07), so every line a handler logs
 * carries the job's identity. Identifiers only — never the payload.
 */
export interface JobLogContext {
  readonly jobId: string;
  readonly jobName: string;
  /** 1 for the first try, 2 for the first retry, … */
  readonly attempt: number;
}

const jobStorage = new AsyncLocalStorage<JobLogContext>();

export function runWithJobContext<T>(context: JobLogContext, fn: () => T): T {
  return jobStorage.run(context, fn);
}

/** The job being processed, or `undefined` outside a job. */
export function currentJobContext(): JobLogContext | undefined {
  return jobStorage.getStore();
}
