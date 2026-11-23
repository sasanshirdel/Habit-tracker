import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import type { WorkerEnv } from '../config/env.js';
import { errorCode } from '../database/prisma.service.js';
import { OutageLogger } from '../queue/outage-logger.js';
import type { QueueName } from '../queue/queue.constants.js';
import { redisRetryDelay } from '../queue/redis-connection.service.js';
import { JOB_HANDLERS, type JobHandler } from './job-handler.js';
import { JOB_REJECTION, createJobProcessor, indexHandlers } from './job-processor.js';

/** What draining needs from a BullMQ worker (narrow, so it can be unit-tested). */
export interface DrainableWorker {
  readonly name: string;
  /** Stops fetching new jobs and resolves once the active ones have finished. */
  close(): Promise<void>;
  /** Drops the connections immediately (active jobs are later recovered as stalled). */
  disconnect(): Promise<void>;
}

export type DrainResult = 'drained' | 'timed_out';

/** Upper bound for dropping connections after a drain timeout (BullMQ's disconnect can itself
 * hang while Redis is unreachable). The process exits afterwards anyway. */
export const DISCONNECT_TIMEOUT_MS = 2_000;

async function disconnectAll(
  workers: readonly DrainableWorker[],
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const done = Promise.allSettled(workers.map((w) => w.disconnect())).then(() => true);
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DISCONNECT_TIMEOUT_MS);
  });
  try {
    if (!(await Promise.race([done, timedOut]))) {
      logger.warn(`Worker connections did not close within ${DISCONNECT_TIMEOUT_MS} ms.`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Graceful shutdown: every worker stops taking jobs and finishes the ones in flight. If that takes
 * longer than `timeoutMs` (a job hangs, or Redis is gone so BullMQ cannot acknowledge), the
 * remaining workers are disconnected (bounded by `DISCONNECT_TIMEOUT_MS`); their unfinished jobs keep their lock until it expires and
 * are then picked up again by a live worker (BullMQ stalled-job recovery), so nothing is lost.
 */
export async function drainWorkers(
  workers: readonly DrainableWorker[],
  timeoutMs: number,
  logger: Pick<Logger, 'log' | 'warn'>,
): Promise<DrainResult> {
  if (workers.length === 0) return 'drained';
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs);
  });
  const closed = Promise.all(workers.map((w) => w.close())).then(() => 'drained' as const);
  try {
    const result = await Promise.race([closed, timedOut]);
    if (result === 'drained') {
      logger.log('All workers drained.');
      return result;
    }
    logger.warn(
      `Workers did not drain within ${timeoutMs} ms; disconnecting. Unfinished jobs will be retried as stalled.`,
    );
    await disconnectAll(workers, logger);
    return result;
  } catch (error) {
    logger.warn(`Worker shutdown failed (${errorCode(error)}); disconnecting.`);
    await disconnectAll(workers, logger);
    return 'timed_out';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the BullMQ consumers of the worker process (backlog P1-03): one `Worker` per queue that has
 * handlers, started when the application context boots. Shut down with `drain()` *before* closing
 * the context, so jobs finish while the database and other providers are still available.
 */
@Injectable()
export class WorkerHost implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHost.name);
  private readonly outage = new OutageLogger(this.logger, 'Redis (worker)');
  private readonly handlers: ReadonlyMap<string, JobHandler>;
  private workers: Worker[] = [];
  private draining: Promise<DrainResult> | undefined;

  constructor(
    @Inject(JOB_HANDLERS) handlers: readonly JobHandler[],
    private readonly config: ConfigService<WorkerEnv, true>,
  ) {
    this.handlers = indexHandlers(handlers);
  }

  /** Names of the queues being consumed. */
  get queues(): QueueName[] {
    return this.workers.map((w) => w.name as QueueName);
  }

  onApplicationBootstrap(): void {
    const byQueue = new Map<QueueName, Map<string, JobHandler>>();
    for (const [name, handler] of this.handlers) {
      const queue = handler.definition.queue;
      const forQueue = byQueue.get(queue) ?? new Map<string, JobHandler>();
      forQueue.set(name, handler);
      byQueue.set(queue, forQueue);
    }
    const prefix = this.config.get('QUEUE_PREFIX', { infer: true });
    const concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true });
    for (const [queue, handlers] of byQueue) {
      const worker = new Worker(queue, createJobProcessor(handlers), {
        // Workers need their own connections (blocking commands) with unlimited retries per
        // request — BullMQ requirement. The URL is never logged.
        connection: {
          url: this.config.get('REDIS_URL', { infer: true }),
          maxRetriesPerRequest: null,
          retryStrategy: redisRetryDelay,
        },
        prefix,
        concurrency,
      });
      worker.on('error', (error: unknown) => this.outage.error(error));
      worker.on('ready', () => this.outage.ready());
      worker.on('failed', (job: Job | undefined, error: Error) => this.logFailure(job, error));
      this.workers.push(worker);
      this.logger.log(
        `Consuming queue "${queue}" (${[...handlers.keys()].join(', ')}), concurrency ${concurrency}.`,
      );
    }
  }

  /** Stops consuming and waits for in-flight jobs (bounded by WORKER_SHUTDOWN_TIMEOUT_MS). */
  drain(): Promise<DrainResult> {
    this.draining ??= drainWorkers(
      this.workers,
      this.config.get('WORKER_SHUTDOWN_TIMEOUT_MS', { infer: true }),
      this.logger,
    );
    return this.draining;
  }

  /** Safety net when the context is closed without `drain()` first. */
  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }

  private logFailure(job: Job | undefined, error: Error): void {
    // Payloads are never logged; the job name/id and an error code are enough to investigate.
    const rejection = Object.values<string>(JOB_REJECTION).includes(error.message)
      ? error.message
      : errorCode(error);
    if (!job) {
      this.logger.warn(`A job failed (${rejection}).`);
      return;
    }
    const attempts = job.opts.attempts ?? 1;
    const final = job.attemptsMade >= attempts || error.name === 'UnrecoverableError';
    this.logger.warn(
      `Job ${job.name} ${job.id ?? '?'} failed attempt ${job.attemptsMade}/${attempts} (${rejection})` +
        (final ? '; moved to the failed set.' : '; will retry.'),
    );
  }
}
