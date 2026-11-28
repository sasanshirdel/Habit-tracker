import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnv } from '../config/env.js';
import { errorCode } from '../database/prisma.service.js';
import { SCHEDULE_TIME_ZONE, type JobScheduleDefinition } from '../queue/job-schedule.js';
import {
  DEFAULT_JOB_OPTIONS,
  ENQUEUE_TIMEOUT_MS,
  QUEUE_NAMES,
  type QueueName,
} from '../queue/queue.constants.js';
import { QueueProducer } from '../queue/queue-producer.service.js';
import { RedisConnection } from '../queue/redis-connection.service.js';
import { JOB_HANDLERS, type JobHandler } from './job-handler.js';

/** Injection token: the recurring jobs the worker registers (ADR-0026). */
export const JOB_SCHEDULES = Symbol('JOB_SCHEDULES');

/**
 * Checks the schedules again this often after a successful sync, so a Redis that lost its data
 * (restart without persistence, failover) gets them back without a worker restart. Schedulers that
 * are registered as declared are not touched ({@link schedulerMatches}).
 */
export const SCHEDULE_RESYNC_INTERVAL_MS = 60 * 60 * 1000;
/** Retry delay after a failed sync: 1 s, 2 s, 4 s, … capped at 60 s. */
export function scheduleRetryDelay(failures: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), 60_000);
}

/** The parts of a stored BullMQ job scheduler that a sync compares. */
export interface StoredScheduler {
  readonly name?: string;
  readonly pattern?: string | null;
  readonly tz?: string | null;
  readonly every?: number | null;
  readonly template?: { readonly data?: unknown; readonly opts?: unknown } | null;
}

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** A template's data as BullMQ returns it (absent when empty; JSON text in some versions). */
function parsedData(data: unknown): unknown {
  if (data === undefined || data === null) return {};
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

/**
 * Whether the stored scheduler already runs `schedule` exactly as declared. Upserting a scheduler
 * re-plans its next run from *now* (BullMQ), so an unchanged scheduler is left alone: a re-sync
 * must never move or repeat a run.
 */
export function schedulerMatches(
  stored: StoredScheduler | undefined,
  schedule: JobScheduleDefinition,
  opts: Record<string, unknown>,
): boolean {
  if (!stored) return false;
  return (
    stored.name === schedule.job.name &&
    stored.pattern === schedule.cron &&
    stored.tz === SCHEDULE_TIME_ZONE &&
    !stored.every &&
    canonical(parsedData(stored.template?.data)) === canonical(schedule.payload) &&
    canonical(stored.template?.opts ?? {}) === canonical(opts)
  );
}

/** What syncing needs from a BullMQ queue (narrow, so it can be unit-tested). */
export interface ScheduleQueue {
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string; tz: string },
    template: { name: string; data: unknown; opts: Record<string, unknown> },
  ): Promise<unknown>;
  getJobScheduler(id: string): Promise<StoredScheduler | undefined>;
  getJobSchedulers(start?: number, end?: number): Promise<ReadonlyArray<{ key: string }>>;
  removeJobScheduler(id: string): Promise<boolean>;
}

export interface ScheduleSyncResult {
  /** Created, or changed (cron, payload, job or options) — their next run was re-planned. */
  readonly upserted: readonly string[];
  /** Already registered exactly as declared; not touched. */
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Startup check (a programming error stops the worker): schedule ids are unique and every
 * scheduled job has a handler in this worker — otherwise each run would fail as `UNKNOWN_JOB`.
 */
export function validateSchedules(
  schedules: readonly JobScheduleDefinition[],
  handlerNames: ReadonlySet<string>,
): void {
  const ids = new Set<string>();
  for (const schedule of schedules) {
    if (ids.has(schedule.id)) throw new Error(`Duplicate job schedule "${schedule.id}"`);
    ids.add(schedule.id);
    if (!handlerNames.has(schedule.job.name)) {
      throw new Error(
        `Schedule "${schedule.id}" runs "${schedule.job.name}", which has no handler`,
      );
    }
  }
}

/**
 * Makes Redis match the declared schedules (ADR-0026): creates each missing or changed one as a
 * BullMQ job scheduler (cron in UTC, the job's own options) and leaves matching ones untouched,
 * then removes schedulers on our queues that are no longer declared, so deleting or renaming a
 * schedule in code takes effect on the next deploy.
 *
 * Safe to run concurrently from every worker replica: an upsert is one atomic Redis script keyed by
 * the schedule id, and the next run's job id is derived from the id and the run time, so replicas
 * never create a second job for the same run.
 */
export async function syncSchedules(
  schedules: readonly JobScheduleDefinition[],
  queueFor: (name: QueueName) => ScheduleQueue,
  queues: readonly QueueName[] = QUEUE_NAMES,
): Promise<ScheduleSyncResult> {
  const upserted: string[] = [];
  const unchanged: string[] = [];
  for (const schedule of schedules) {
    const queue = queueFor(schedule.job.queue);
    const opts = { ...DEFAULT_JOB_OPTIONS, ...schedule.job.options };
    if (schedulerMatches(await queue.getJobScheduler(schedule.id), schedule, opts)) {
      unchanged.push(schedule.id);
      continue;
    }
    await queue.upsertJobScheduler(
      schedule.id,
      { pattern: schedule.cron, tz: SCHEDULE_TIME_ZONE },
      { name: schedule.job.name, data: schedule.payload, opts },
    );
    upserted.push(schedule.id);
  }
  const removed: string[] = [];
  for (const name of queues) {
    const declared = new Set(schedules.filter((s) => s.job.queue === name).map((s) => s.id));
    const queue = queueFor(name);
    for (const scheduler of await queue.getJobSchedulers(0, -1)) {
      if (declared.has(scheduler.key)) continue;
      if (await queue.removeJobScheduler(scheduler.key)) removed.push(scheduler.key);
    }
  }
  return { upserted, unchanged, removed };
}

class SyncTimeoutError extends Error {
  readonly code = 'SCHEDULE_SYNC_TIMEOUT';
}

/**
 * Registers the recurring jobs of the worker process (backlog P2-10 follow-up, ADR-0026).
 *
 * Starts in the background at bootstrap and never blocks or crashes the worker: while Redis is
 * unreachable it retries with backoff (the outage itself is logged by the connection), then
 * re-syncs every {@link SCHEDULE_RESYNC_INTERVAL_MS}. `JOB_SCHEDULES_ENABLED=false` leaves Redis
 * untouched (tests, or a deployment that schedules elsewhere). Logs schedule ids and cron
 * expressions only.
 */
@Injectable()
export class JobScheduleRegistrar implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobScheduleRegistrar.name);
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private failures = 0;
  private resolveFirstSync!: () => void;
  /** Resolves after the first successful sync (tests, diagnostics). */
  readonly firstSync = new Promise<void>((resolve) => (this.resolveFirstSync = resolve));
  /** Overridable in tests. */
  resyncIntervalMs = SCHEDULE_RESYNC_INTERVAL_MS;
  timeoutMs = ENQUEUE_TIMEOUT_MS;

  constructor(
    @Inject(JOB_SCHEDULES) readonly schedules: readonly JobScheduleDefinition[],
    @Inject(JOB_HANDLERS) handlers: readonly JobHandler[],
    private readonly producer: QueueProducer,
    private readonly redis: RedisConnection,
    private readonly config: ConfigService<WorkerEnv, true>,
  ) {
    validateSchedules(schedules, new Set(handlers.map((h) => h.definition.name)));
  }

  get enabled(): boolean {
    return this.config.get('JOB_SCHEDULES_ENABLED', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log(
        `Job schedules disabled (JOB_SCHEDULES_ENABLED=false); ${this.schedules.length} declared, none registered.`,
      );
      return;
    }
    this.loop = this.run();
  }

  /** One sync, bounded by {@link timeoutMs} per Redis call batch. Throws on failure. */
  async sync(): Promise<ScheduleSyncResult> {
    if (!this.redis.isReady) throw Object.assign(new Error('not connected'), { code: 'NOT_READY' });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SyncTimeoutError()), this.timeoutMs);
    });
    try {
      return await Promise.race([
        syncSchedules(this.schedules, (name) => this.producer.queue(name)),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stops the background loop and waits for a sync in flight. Idempotent. */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async run(): Promise<void> {
    let synced = false;
    while (!this.abort.signal.aborted) {
      let wait: number;
      try {
        const result = await this.sync();
        this.failures = 0;
        wait = this.resyncIntervalMs;
        const summary = this.schedules.map((s) => `${s.id} (${s.cron} UTC)`).join(', ');
        const removed = result.removed.length > 0 ? `; removed ${result.removed.join(', ')}` : '';
        const changed =
          result.upserted.length > 0 ? `; registered ${result.upserted.join(', ')}` : '';
        if (!synced || result.upserted.length > 0 || result.removed.length > 0) {
          this.logger.log(`Job schedules synced: ${summary || 'none'}${changed}${removed}.`);
        } else {
          this.logger.debug(`Job schedules re-synced (${this.schedules.length}).`);
        }
        if (!synced) this.resolveFirstSync();
        synced = true;
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.failures += 1;
        wait = scheduleRetryDelay(this.failures);
        // Not-ready is expected while Redis is down (the connection logs the outage once).
        if (errorCode(error) !== 'NOT_READY') {
          this.logger.warn(
            `Job schedule sync failed (${errorCode(error)}); retrying in ${wait} ms.`,
          );
        }
      }
      await this.sleep(wait);
    }
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
