import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineJob } from '../queue/job-definition.js';
import { SYSTEM_NOOP_JOB } from '../queue/jobs/system-noop.job.js';
import type { JobHandler } from './job-handler.js';
import { JOB_REJECTION, createJobProcessor, indexHandlers } from './job-processor.js';

const ECHO_JOB = defineJob({
  name: 'test.echo',
  queue: 'system',
  schema: z.strictObject({ id: z.uuid(), times: z.int().min(1).default(1) }),
});

function handlerFor(handle = vi.fn().mockResolvedValue(undefined)): JobHandler & {
  handle: typeof handle;
} {
  return { definition: ECHO_JOB, handle };
}

const id = '0195f2a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f';
const job = (name: string, data: unknown, attemptsMade = 0) => ({
  id: '42',
  name,
  data,
  attemptsMade,
  opts: { attempts: 3 },
});

describe('createJobProcessor', () => {
  it('passes the validated payload (with defaults) and the attempt context to the handler', async () => {
    const handler = handlerFor();
    const process = createJobProcessor(indexHandlers([handler]));
    await process(job('test.echo', { id }, 1));
    expect(handler.handle).toHaveBeenCalledWith(
      { id, times: 1 },
      { jobId: '42', attempt: 2, maxAttempts: 3 },
    );
  });

  it('fails unknown job names without retry', async () => {
    const process = createJobProcessor(indexHandlers([handlerFor()]));
    const result = process(job('test.unknown', {}));
    await expect(result).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(result).rejects.toThrow(JOB_REJECTION.unknownJob);
  });

  it.each([
    ['missing field', {}],
    ['wrong type', { id: 'not-a-uuid' }],
    ['extra field (e.g. smuggled content)', { id, note: 'journal text' }],
    ['not an object', 'x'],
  ])(
    'fails an invalid payload (%s) without retry and without calling the handler',
    async (_, data) => {
      const handler = handlerFor();
      const process = createJobProcessor(indexHandlers([handler]));
      const result = process(job('test.echo', data));
      await expect(result).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(result).rejects.toThrow(JOB_REJECTION.invalidPayload);
      expect(handler.handle).not.toHaveBeenCalled();
    },
  );

  it('propagates handler errors unchanged so BullMQ retries them', async () => {
    const boom = new Error('transient');
    const process = createJobProcessor(
      indexHandlers([handlerFor(vi.fn().mockRejectedValue(boom))]),
    );
    await expect(process(job('test.echo', { id }))).rejects.toBe(boom);
  });
});

describe('indexHandlers', () => {
  it('rejects two handlers for the same job name', () => {
    expect(() => indexHandlers([handlerFor(), handlerFor()])).toThrow(/Duplicate.*test\.echo/);
  });
});

describe('SYSTEM_NOOP_JOB payload', () => {
  it('accepts an id and bounded work duration, defaulting workMs to 0', () => {
    expect(SYSTEM_NOOP_JOB.schema.parse({ correlationId: id })).toEqual({
      correlationId: id,
      workMs: 0,
    });
  });

  it.each([
    { correlationId: id, workMs: 10_001 },
    { correlationId: id, workMs: -1 },
    { correlationId: id, extra: 1 },
  ])('rejects %j', (payload) => {
    expect(SYSTEM_NOOP_JOB.schema.safeParse(payload).success).toBe(false);
  });
});

describe('defineJob', () => {
  it.each(['noop', 'System.noop', 'system.', 'system noop'])('rejects job name %j', (name) => {
    expect(() => defineJob({ name, queue: 'system', schema: z.object({}) })).toThrow(/job name/);
  });
});
