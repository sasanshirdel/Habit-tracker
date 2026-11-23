import { Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { SYSTEM_NOOP_JOB } from '../queue/jobs/system-noop.job.js';
import type { JobPayload } from '../queue/job-definition.js';
import type { JobContext, JobHandler } from './job-handler.js';

/** Handler for the example `system.noop` job: waits `workMs`, then succeeds. */
@Injectable()
export class SystemNoopJobHandler implements JobHandler<typeof SYSTEM_NOOP_JOB.schema> {
  private readonly logger = new Logger(SystemNoopJobHandler.name);
  readonly definition = SYSTEM_NOOP_JOB;

  async handle(payload: JobPayload<typeof SYSTEM_NOOP_JOB>, context: JobContext): Promise<void> {
    if (payload.workMs > 0) await sleep(payload.workMs);
    this.logger.debug(
      `system.noop ${payload.correlationId} done (job ${context.jobId}, attempt ${context.attempt}).`,
    );
  }
}
