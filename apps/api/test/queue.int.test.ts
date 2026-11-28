import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import type * as QueueApi from '../src/queue/index.js';
import type * as WorkerApi from '../src/worker/index.js';
import { waitForJobState } from './integration/queue-helpers.js';

// Integration (backlog P1-03): the API enqueues, a worker context consumes — both against the real
// Redis (and PostgreSQL for readiness) provided by global setup. Queue keys live under the run's
// key prefix, which global teardown deletes.
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');

let queueApi: typeof QueueApi;
let workerApi: typeof WorkerApi;

/** Attempt timestamps recorded by the test handlers, by correlation id. */
const attempts = new Map<string, number[]>();
const record = (id: string) => attempts.set(id, [...(attempts.get(id) ?? []), Date.now()]);
const payloadSchema = z.strictObject({ correlationId: z.uuid() });

async function startWorker(withTestHandlers: boolean): Promise<TestingModule> {
  const { defineJob } = queueApi;
  const { JOB_HANDLERS, SystemNoopJobHandler, WorkerModule } = workerApi;
  // Test-only job types on the same queue: one always fails, one fails twice then succeeds.
  const ALWAYS_FAILS = defineJob({
    name: 'test.always-fails',
    queue: 'system',
    schema: payloadSchema,
    options: { attempts: 3, backoff: { type: 'exponential', delay: 100 } },
  });
  const FLAKY = defineJob({
    name: 'test.flaky',
    queue: 'system',
    schema: payloadSchema,
    options: { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
  });
  const testHandlers: WorkerApi.JobHandler[] = [
    {
      definition: ALWAYS_FAILS,
      handle: async ({ correlationId }: { correlationId: string }) => {
        record(correlationId);
        throw new Error('transient failure');
      },
    },
    {
      definition: FLAKY,
      handle: async ({ correlationId }: { correlationId: string }, { attempt }) => {
        record(correlationId);
        if (attempt < 3) throw new Error('flaky');
      },
    },
  ];
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(JOB_HANDLERS)
    .useFactory({
      factory: (noop: InstanceType<typeof SystemNoopJobHandler>) =>
        withTestHandlers ? [noop, ...testHandlers] : [noop],
      inject: [SystemNoopJobHandler],
    })
    // Only test handlers here, so no recurring jobs (their handlers are not registered).
    .overrideProvider(workerApi.JOB_SCHEDULES)
    .useValue([])
    .compile();
  await moduleRef.init();
  return moduleRef;
}

describe('queues and worker (real Redis)', () => {
  let app: INestApplication;
  let producer: QueueApi.QueueProducer;
  let worker: TestingModule;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.QUEUE_PREFIX = `${keyPrefix}q`;
    // Imported lazily: ConfigModule validates env when the modules are first evaluated.
    queueApi = await import('../src/queue/index.js');
    workerApi = await import('../src/worker/index.js');
    const { createApp } = await import('../src/app.factory.js');
    app = await createApp();
    await app.init();
    producer = app.get(queueApi.QueueProducer);
    // Wait for the shared connection so the first enqueue does not race the initial connect.
    const redis = app.get(queueApi.RedisConnection);
    for (let i = 0; i < 100 && !redis.isReady; i++) await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports PostgreSQL and Redis ready', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('writes queue keys only under QUEUE_PREFIX', async () => {
    const queue = producer.queue('system');
    expect(queue.opts.prefix).toBe(`${keyPrefix}q`);
  });

  describe('with a worker consuming', () => {
    beforeAll(async () => {
      worker = await startWorker(true);
      expect(worker.get(workerApi.WorkerHost).queues).toEqual(['system']);
    });

    afterAll(async () => {
      await worker?.get(workerApi.WorkerHost).drain();
      await worker?.close();
    });

    it('processes a job enqueued by the API', async () => {
      const job = await producer.enqueue(queueApi.SYSTEM_NOOP_JOB, {
        correlationId: randomUUID(),
      });
      expect(job).toMatchObject({ name: 'system.noop', queue: 'system' });
      const done = await waitForJobState(producer.queue('system'), job.id, 'completed');
      expect(done.attemptsMade).toBe(1);
      expect(done.data).toMatchObject({ workMs: 0 }); // schema defaults applied by the producer
    });

    it('deduplicates by job id (idempotent enqueue)', async () => {
      const jobId = `noop-${randomUUID()}`;
      const payload = { correlationId: randomUUID() };
      const first = await producer.enqueue(queueApi.SYSTEM_NOOP_JOB, payload, { jobId });
      const second = await producer.enqueue(queueApi.SYSTEM_NOOP_JOB, payload, { jobId });
      expect(second.id).toBe(first.id);
      await waitForJobState(producer.queue('system'), jobId, 'completed');
    });

    it('retries a failing job with exponential backoff, then keeps it in the failed set', async () => {
      const correlationId = randomUUID();
      const definition = {
        name: 'test.always-fails',
        queue: 'system',
        schema: payloadSchema,
      } as const;
      const job = await producer.enqueue(definition, { correlationId });
      const failed = await waitForJobState(producer.queue('system'), job.id, 'failed');

      expect(failed.attemptsMade).toBe(3);
      expect(failed.failedReason).toBe('transient failure');
      const times = attempts.get(correlationId) ?? [];
      expect(times).toHaveLength(3);
      const [t1 = 0, t2 = 0, t3 = 0] = times;
      // Exponential backoff with delay 100 ms: ~100 ms, then ~200 ms between attempts.
      expect(t2 - t1).toBeGreaterThanOrEqual(90);
      expect(t3 - t2).toBeGreaterThanOrEqual(180);

      const failedSet = await producer.queue('system').getFailed();
      expect(failedSet.map((j) => j.id)).toContain(job.id);
    });

    it('recovers when a retry succeeds', async () => {
      const correlationId = randomUUID();
      const job = await producer.enqueue(
        { name: 'test.flaky', queue: 'system', schema: payloadSchema },
        { correlationId },
      );
      const done = await waitForJobState(producer.queue('system'), job.id, 'completed');
      expect(done.attemptsMade).toBe(3);
      expect(attempts.get(correlationId)).toHaveLength(3);
    });

    it('fails a job with an invalid payload immediately, without retries', async () => {
      // Bypasses the producer's validation, as a job written by another release or by hand would.
      const raw = await producer
        .queue('system')
        .add('system.noop', { correlationId: 'not-a-uuid', note: 'unexpected' });
      const failed = await waitForJobState(producer.queue('system'), raw.id ?? '', 'failed');
      expect(failed.failedReason).toBe(workerApi.JOB_REJECTION.invalidPayload);
      expect(failed.attemptsMade).toBe(1);
    });

    it('fails an unknown job name immediately', async () => {
      const raw = await producer.queue('system').add('system.does-not-exist', {});
      const failed = await waitForJobState(producer.queue('system'), raw.id ?? '', 'failed');
      expect(failed.failedReason).toBe(workerApi.JOB_REJECTION.unknownJob);
    });
  });

  describe('graceful shutdown', () => {
    it('drains: an in-flight job finishes before the worker stops, and no new job is taken', async () => {
      const shutdownWorker = await startWorker(false);
      const queue = producer.queue('system');
      const slow = await producer.enqueue(queueApi.SYSTEM_NOOP_JOB, {
        correlationId: randomUUID(),
        workMs: 1_500,
      });
      await waitForJobState(queue, slow.id, 'active');

      const started = Date.now();
      const result = await shutdownWorker.get(workerApi.WorkerHost).drain();
      const elapsed = Date.now() - started;
      expect(result).toBe('drained');
      expect(elapsed).toBeGreaterThanOrEqual(500); // waited for the job instead of abandoning it
      expect(await (await queue.getJob(slow.id))?.getState()).toBe('completed');

      const after = await producer.enqueue(queueApi.SYSTEM_NOOP_JOB, {
        correlationId: randomUUID(),
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(await (await queue.getJob(after.id))?.getState()).toBe('waiting');

      await shutdownWorker.close();
      await queue.remove(after.id);
    });
  });
});
