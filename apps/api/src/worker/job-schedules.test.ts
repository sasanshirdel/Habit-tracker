import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ConfigService } from '@nestjs/config';
import type { WorkerEnv } from '../config/env.js';
import { IDENTITY_SCHEDULES } from '../modules/identity/index.js';
import { defineJob } from '../queue/job-definition.js';
import { defineSchedule } from '../queue/job-schedule.js';
import type { QueueName } from '../queue/queue.constants.js';
import type { QueueProducer } from '../queue/queue-producer.service.js';
import type { RedisConnection } from '../queue/redis-connection.service.js';
import type { JobHandler } from './job-handler.js';
import {
  JobScheduleRegistrar,
  scheduleRetryDelay,
  syncSchedules,
  validateSchedules,
  schedulerMatches,
  type ScheduleQueue,
  type StoredScheduler,
} from './job-schedules.service.js';

const SYSTEM_JOB = defineJob({
  name: 'test.system-task',
  queue: 'system',
  schema: z.strictObject({ size: z.int().default(10) }),
  options: { attempts: 5 },
});
const EMAIL_JOB = defineJob({
  name: 'test.email-task',
  queue: 'email',
  schema: z.strictObject({}),
});
const SYSTEM_SCHEDULE = defineSchedule({
  id: 'test.system-daily',
  job: SYSTEM_JOB,
  cron: '30 23 * * *',
  payload: {},
  description: 'test',
});
const EMAIL_SCHEDULE = defineSchedule({
  id: 'test.email-hourly',
  job: EMAIL_JOB,
  cron: '0 * * * *',
  payload: {},
  description: 'test',
});

function fakeQueue(existing: string[] = []) {
  const stored = new Map<string, StoredScheduler>(existing.map((id) => [id, {}]));
  const queue = {
    upsertJobScheduler: vi.fn(
      async (
        id: string,
        repeat: { pattern: string; tz: string },
        template: { name: string; data: unknown; opts: Record<string, unknown> },
      ) => {
        // Like BullMQ: an empty payload is not stored.
        const data = Object.keys(template.data as object).length > 0 ? template.data : undefined;
        stored.set(id, { ...repeat, name: template.name, template: { data, opts: template.opts } });
        return {};
      },
    ),
    getJobScheduler: vi.fn(async (id: string) => stored.get(id)),
    getJobSchedulers: vi.fn(async () => [...stored.keys()].map((key) => ({ key }))),
    removeJobScheduler: vi.fn(async (id: string) => stored.delete(id)),
  } satisfies ScheduleQueue;
  return { queue, schedulers: { values: () => stored.keys() }, stored };
}

const handler = (name: string) => ({ definition: { name } }) as unknown as JobHandler;

describe('validateSchedules', () => {
  it('accepts schedules whose jobs have handlers', () => {
    expect(() =>
      validateSchedules([SYSTEM_SCHEDULE], new Set(['test.system-task', 'other'])),
    ).not.toThrow();
  });
  it('rejects a scheduled job without a handler', () => {
    expect(() => validateSchedules([EMAIL_SCHEDULE], new Set(['test.system-task']))).toThrow(
      /test\.email-task", which has no handler/,
    );
  });
  it('rejects duplicate schedule ids', () => {
    expect(() =>
      validateSchedules([SYSTEM_SCHEDULE, SYSTEM_SCHEDULE], new Set(['test.system-task'])),
    ).toThrow(/Duplicate job schedule/);
  });
});

describe('syncSchedules', () => {
  it('upserts each schedule on its queue: cron in UTC, job name, parsed payload, job options', async () => {
    const system = fakeQueue();
    const email = fakeQueue();
    const queues: Record<QueueName, ScheduleQueue> = { system: system.queue, email: email.queue };
    const result = await syncSchedules([SYSTEM_SCHEDULE, EMAIL_SCHEDULE], (n) => queues[n]);

    expect(result).toEqual({
      upserted: ['test.system-daily', 'test.email-hourly'],
      unchanged: [],
      removed: [],
    });
    expect(system.queue.upsertJobScheduler).toHaveBeenCalledWith(
      'test.system-daily',
      { pattern: '30 23 * * *', tz: 'UTC' },
      {
        name: 'test.system-task',
        data: { size: 10 },
        // Defaults (retention of completed/failed jobs) plus the job's own overrides.
        opts: expect.objectContaining({
          attempts: 5,
          removeOnComplete: expect.any(Object),
          removeOnFail: expect.any(Object),
        }),
      },
    );
    expect(email.queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('leaves a scheduler registered exactly as declared untouched (re-sync never re-plans a run)', async () => {
    const system = fakeQueue();
    const email = fakeQueue();
    const queues: Record<QueueName, ScheduleQueue> = { system: system.queue, email: email.queue };
    await syncSchedules([SYSTEM_SCHEDULE], (n) => queues[n]);
    const again = await syncSchedules([SYSTEM_SCHEDULE], (n) => queues[n]);
    expect(again).toEqual({ upserted: [], unchanged: ['test.system-daily'], removed: [] });
    expect(system.queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('re-registers a scheduler whose cron, job, payload or options changed', async () => {
    const changed = defineSchedule({ ...SYSTEM_SCHEDULE, cron: '0 2 * * *', payload: {} });
    const system = fakeQueue();
    const email = fakeQueue();
    const queues: Record<QueueName, ScheduleQueue> = { system: system.queue, email: email.queue };
    await syncSchedules([SYSTEM_SCHEDULE], (n) => queues[n]);
    const result = await syncSchedules([changed], (n) => queues[n]);
    expect(result.upserted).toEqual(['test.system-daily']);
    expect(system.stored.get('test.system-daily')).toMatchObject({ pattern: '0 2 * * *' });
  });

  it('removes schedulers that are no longer declared, per queue, and keeps declared ones', async () => {
    const system = fakeQueue(['test.system-daily', 'old.renamed-daily']);
    const email = fakeQueue(['test.system-daily-on-wrong-queue']);
    const queues: Record<QueueName, ScheduleQueue> = { system: system.queue, email: email.queue };
    const result = await syncSchedules([SYSTEM_SCHEDULE], (n) => queues[n]);

    expect([...result.removed].sort()).toEqual([
      'old.renamed-daily',
      'test.system-daily-on-wrong-queue',
    ]);
    expect([...system.schedulers.values()]).toEqual(['test.system-daily']);
    expect([...email.schedulers.values()]).toEqual([]);
  });

  it('with no schedules declared, clears every scheduler', async () => {
    const system = fakeQueue(['a.b']);
    const email = fakeQueue();
    const queues: Record<QueueName, ScheduleQueue> = { system: system.queue, email: email.queue };
    expect(await syncSchedules([], (n) => queues[n])).toEqual({
      upserted: [],
      unchanged: [],
      removed: ['a.b'],
    });
  });
});

describe('schedulerMatches', () => {
  const opts = { attempts: 5 };
  const stored = {
    name: 'test.system-task',
    pattern: '30 23 * * *',
    tz: 'UTC',
    template: { data: { size: 10 }, opts: { attempts: 5 } },
  };
  it('matches the same schedule regardless of key order or JSON-encoded data', () => {
    expect(schedulerMatches(stored, SYSTEM_SCHEDULE, opts)).toBe(true);
    expect(
      schedulerMatches(
        { ...stored, template: { data: '{"size":10}', opts: { attempts: 5 } } },
        SYSTEM_SCHEDULE,
        opts,
      ),
    ).toBe(true);
  });
  it.each([
    ['missing', undefined],
    ['other job', { ...stored, name: 'test.other' }],
    ['other cron', { ...stored, pattern: '0 0 * * *' }],
    ['other zone', { ...stored, tz: 'Asia/Tehran' }],
    ['interval', { ...stored, every: 1000 }],
    ['other payload', { ...stored, template: { data: { size: 11 }, opts } }],
    ['other options', { ...stored, template: { data: { size: 10 }, opts: { attempts: 1 } } }],
  ])('does not match: %s', (_label, candidate) => {
    expect(schedulerMatches(candidate, SYSTEM_SCHEDULE, opts)).toBe(false);
  });
});

describe('scheduleRetryDelay', () => {
  it('backs off from 1 s, doubling, capped at 60 s', () => {
    expect([1, 2, 3, 4, 7, 8, 50].map(scheduleRetryDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe('JobScheduleRegistrar', () => {
  afterEach(() => vi.useRealTimers());

  function setup(options: { enabled: boolean; ready: boolean }) {
    const system = fakeQueue();
    const email = fakeQueue();
    const queues: Record<QueueName, ScheduleQueue> = { system: system.queue, email: email.queue };
    const redis = { isReady: options.ready };
    const config = { get: () => options.enabled } as unknown as ConfigService<WorkerEnv, true>;
    const registrar = new JobScheduleRegistrar(
      [SYSTEM_SCHEDULE],
      [handler('test.system-task')],
      { queue: (name: QueueName) => queues[name] } as unknown as QueueProducer,
      redis as unknown as RedisConnection,
      config,
    );
    const warn = vi.spyOn(
      (registrar as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    );
    const log = vi.spyOn((registrar as unknown as { logger: { log: () => void } }).logger, 'log');
    warn.mockImplementation(() => undefined);
    vi.spyOn(
      (registrar as unknown as { logger: { debug: () => void } }).logger,
      'debug',
    ).mockImplementation(() => undefined);
    log.mockImplementation(() => undefined);
    return { registrar, system, redis, warn, log };
  }

  it('refuses to start when a scheduled job has no handler', () => {
    expect(
      () =>
        new JobScheduleRegistrar(
          [EMAIL_SCHEDULE],
          [handler('test.system-task')],
          {} as QueueProducer,
          {} as RedisConnection,
          { get: () => true } as unknown as ConfigService<WorkerEnv, true>,
        ),
    ).toThrow(/no handler/);
  });

  it('does nothing when JOB_SCHEDULES_ENABLED=false', async () => {
    const { registrar, system, log } = setup({ enabled: false, ready: true });
    registrar.onApplicationBootstrap();
    await registrar.stop();
    expect(system.queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Job schedules disabled/));
  });

  it('syncs at bootstrap, logs ids and cron only, then re-syncs on its interval', async () => {
    vi.useFakeTimers();
    const { registrar, system, log } = setup({ enabled: true, ready: true });
    registrar.resyncIntervalMs = 10_000;
    registrar.onApplicationBootstrap();
    await registrar.firstSync;
    expect(system.queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'Job schedules synced: test.system-daily (30 23 * * * UTC); registered test.system-daily.',
    );
    expect(system.queue.getJobScheduler).toHaveBeenCalledTimes(1);
    // The re-sync checks the scheduler again but leaves it alone: it is registered as declared.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(system.queue.getJobScheduler).toHaveBeenCalledTimes(2);
    expect(system.queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    // Lost from Redis (restart without persistence): the next re-sync registers it again.
    system.stored.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(system.queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    await registrar.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(system.queue.getJobScheduler).toHaveBeenCalledTimes(3);
  });

  it('waits for Redis without crashing or warning, then syncs once it is ready', async () => {
    vi.useFakeTimers();
    const { registrar, system, redis, warn } = setup({ enabled: true, ready: false });
    registrar.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(system.queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    redis.isReady = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await registrar.firstSync;
    expect(system.queue.upsertJobScheduler).toHaveBeenCalled();
    await registrar.stop();
  });

  it('retries a failed sync with backoff and logs only the error code', async () => {
    vi.useFakeTimers();
    const { registrar, system, warn } = setup({ enabled: true, ready: true });
    system.queue.upsertJobScheduler.mockRejectedValueOnce(
      Object.assign(new Error('redis://user:secret@host failed'), { code: 'ECONNRESET' }),
    );
    registrar.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(
      'Job schedule sync failed (ECONNRESET); retrying in 1000 ms.',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    await vi.advanceTimersByTimeAsync(1_000);
    await registrar.firstSync;
    expect(system.queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    await registrar.stop();
  });

  it('gives up a sync that hangs after its timeout and retries', async () => {
    vi.useFakeTimers();
    const { registrar, system, warn } = setup({ enabled: true, ready: true });
    registrar.timeoutMs = 500;
    system.queue.upsertJobScheduler.mockImplementationOnce(() => new Promise(() => {}));
    registrar.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(500);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/SCHEDULE_SYNC_TIMEOUT/));
    await vi.advanceTimersByTimeAsync(1_000);
    await registrar.firstSync;
    await registrar.stop();
  });

  it('stop() ends a pending retry wait immediately', async () => {
    const { registrar } = setup({ enabled: true, ready: false });
    registrar.onApplicationBootstrap();
    const started = Date.now();
    await registrar.stop();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('identity schedules', () => {
  it('declares the daily account purge and retention clean-up at distinct night-time UTC slots', () => {
    expect(IDENTITY_SCHEDULES.map((s) => [s.id, s.job.name, s.cron])).toEqual([
      ['identity.account-purge-daily', 'identity.account-purge', '30 23 * * *'],
      ['identity.retention-cleanup-daily', 'identity.retention-cleanup', '45 23 * * *'],
    ]);
    expect(IDENTITY_SCHEDULES.every((s) => s.job.queue === 'system')).toBe(true);
  });
});
