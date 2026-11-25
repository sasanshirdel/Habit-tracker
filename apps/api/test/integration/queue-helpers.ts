import type { Job, Queue } from 'bullmq';

export type JobState = Awaited<ReturnType<Job['getState']>>;

/** Polls until the job reaches `state` (or fails the test after `timeoutMs`). */
export async function waitForJobState(
  queue: Queue,
  id: string,
  state: JobState,
  timeoutMs = 15_000,
): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  let last: JobState | 'missing' = 'missing';
  while (Date.now() < deadline) {
    const job = await queue.getJob(id);
    if (job) {
      last = await job.getState();
      if (last === state) {
        // Re-read: `job` was loaded before the state check, so it may predate the transition
        // (e.g. no failedReason yet). Fields are written before the state changes.
        const fresh = await queue.getJob(id);
        if (fresh) return fresh;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${id} did not reach "${state}" within ${timeoutMs} ms (last: ${last})`);
}
