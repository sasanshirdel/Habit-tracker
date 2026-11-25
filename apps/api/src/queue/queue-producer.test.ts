import 'reflect-metadata';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBaseEnv } from '../config/env.js';
import { InvalidJobIdError, InvalidJobPayloadError, QueueUnavailableError } from './errors.js';
import { SYSTEM_NOOP_JOB } from './jobs/system-noop.job.js';
import { QueueProducer } from './queue-producer.service.js';
import { QueueModule } from './queue.module.js';

// No Redis runs for unit tests (vitest.config.ts points REDIS_URL at a closed port): this covers
// validation and the fail-fast path. Enqueue → worker processing is covered by
// test/queue.int.test.ts against real Redis.
describe('QueueProducer (Redis unavailable)', () => {
  let moduleRef: TestingModule;
  let producer: QueueProducer;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateBaseEnv }),
        QueueModule,
      ],
    }).compile();
    await moduleRef.init();
    producer = moduleRef.get(QueueProducer);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  const correlationId = '0195f2a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f';

  it('rejects an invalid payload before touching Redis, naming fields but not values', async () => {
    const attempt = producer.enqueue(SYSTEM_NOOP_JOB, {
      correlationId: 'secret-value-not-a-uuid',
      workMs: 99_999,
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidJobPayloadError);
    const error = (await attempt.catch((e: unknown) => e)) as InvalidJobPayloadError;
    expect(error.code).toBe('INVALID_JOB_PAYLOAD');
    expect(error.fields).toEqual(['correlationId', 'workMs']);
    expect(error.message).not.toContain('secret-value');
  });

  it.each(['123', 'has:colon', '', 'x'.repeat(129)])('rejects job id %j', async (jobId) => {
    await expect(
      producer.enqueue(SYSTEM_NOOP_JOB, { correlationId }, { jobId }),
    ).rejects.toBeInstanceOf(InvalidJobIdError);
  });

  it('fails fast with QUEUE_UNAVAILABLE instead of buffering the job', async () => {
    const started = Date.now();
    const attempt = producer.enqueue(SYSTEM_NOOP_JOB, { correlationId });
    await expect(attempt).rejects.toBeInstanceOf(QueueUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: 'QUEUE_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
