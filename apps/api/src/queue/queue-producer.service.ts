import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { BaseEnv } from '../config/env.js';
import { InvalidJobIdError, InvalidJobPayloadError, QueueUnavailableError } from './errors.js';
import type { JobDefinition, JobInput } from './job-definition.js';
import {
  DEFAULT_JOB_OPTIONS,
  ENQUEUE_TIMEOUT_MS,
  QUEUE_NAMES,
  type QueueName,
} from './queue.constants.js';
import { RedisConnection } from './redis-connection.service.js';

export interface EnqueueOptions {
  /**
   * Idempotency key: enqueueing the same id twice keeps the first job (BullMQ ignores the
   * duplicate). Use a deterministic id when a retried request must not create a second job.
   */
  jobId?: string;
  /** Run no earlier than this many milliseconds from now. */
  delayMs?: number;
}

export interface EnqueuedJob {
  id: string;
  name: string;
  queue: QueueName;
}

const JOB_ID = /^(?!\d+$)[A-Za-z0-9_-]{1,128}$/;

/**
 * Producer side of the queues (backlog P1-03). Modules enqueue work through `enqueue` with a
 * `JobDefinition`; they never touch BullMQ directly.
 *
 * Fail-fast semantics: when Redis is not connected, or does not answer within
 * `ENQUEUE_TIMEOUT_MS`, `enqueue` rejects with `QueueUnavailableError` instead of buffering the
 * job in memory (a buffered job would be lost on restart, or be added after the caller was told
 * it failed). Callers decide whether that is fatal for their request.
 */
@Injectable()
export class QueueProducer implements OnModuleDestroy {
  private readonly queues: ReadonlyMap<QueueName, Queue>;
  /** Overridable in tests; production uses the default. */
  timeoutMs = ENQUEUE_TIMEOUT_MS;

  constructor(
    @Inject(RedisConnection) private readonly redis: RedisConnection,
    config: ConfigService<BaseEnv, true>,
  ) {
    const prefix = config.get('QUEUE_PREFIX', { infer: true });
    this.queues = new Map(
      QUEUE_NAMES.map((name) => {
        const queue = new Queue(name, {
          // Shares the process connection: no extra sockets, one place that tracks readiness.
          connection: redis.client,
          prefix,
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        });
        queue.on('error', (error: unknown) => redis.reportError(error));
        return [name, queue] as const;
      }),
    );
  }

  async enqueue<D extends JobDefinition>(
    definition: D,
    payload: JobInput<D>,
    options: EnqueueOptions = {},
  ): Promise<EnqueuedJob> {
    const parsed = definition.schema.safeParse(payload);
    if (!parsed.success) {
      throw new InvalidJobPayloadError(
        definition.name,
        parsed.error.issues.map((issue) => issue.path.join('.')),
      );
    }
    if (options.jobId !== undefined && !JOB_ID.test(options.jobId)) throw new InvalidJobIdError();
    if (!this.redis.isReady) throw new QueueUnavailableError('not_connected');

    const queue = this.queue(definition.queue);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new QueueUnavailableError('timeout')), this.timeoutMs);
    });
    try {
      const job = await Promise.race([
        queue.add(definition.name, parsed.data, {
          ...definition.options,
          ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
          ...(options.delayMs === undefined ? {} : { delay: Math.max(0, options.delayMs) }),
        }),
        timeout,
      ]);
      if (job.id === undefined) throw new QueueUnavailableError('not_connected');
      return { id: job.id, name: definition.name, queue: definition.queue };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The underlying queue, for inspection (counts, failed set) by tests and admin tooling. */
  queue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Unknown queue "${name}"`);
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    // Closes BullMQ's use of the shared connection; the connection itself is closed later by
    // RedisConnection.onApplicationShutdown.
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}
