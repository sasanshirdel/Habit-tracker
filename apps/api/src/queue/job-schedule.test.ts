import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob } from './job-definition.js';
import { SCHEDULE_TIME_ZONE, defineSchedule, isSupportedCron } from './job-schedule.js';
import { SYSTEM_NOOP_JOB } from './jobs/system-noop.job.js';

const EMPTY_JOB = defineJob({ name: 'test.empty', queue: 'system', schema: z.strictObject({}) });

describe('isSupportedCron (ADR-0026)', () => {
  it.each([
    '30 23 * * *',
    '45 23 * * *',
    '0 0 1 1 0',
    '*/15 * * * *',
    '0 3 * * 1-5',
    '0,30 8-18/2 * * *',
    '59 23 31 12 7',
    '  5   4 * * *  ',
  ])('accepts %j', (cron) => expect(isSupportedCron(cron)).toBe(true));

  it.each([
    '',
    '* * * *', // four fields
    '0 * * * * *', // seconds field
    '60 * * * *',
    '0 24 * * *',
    '0 0 0 * *', // day of month starts at 1
    '0 0 * 13 *',
    '0 0 * * 8',
    '0 0 * * MON', // names not supported
    '0 0 L * *',
    '0 0 ? * *',
    '*/0 * * * *',
    '5-1 * * * *', // reversed range
    '@daily',
  ])('rejects %j', (cron) => expect(isSupportedCron(cron)).toBe(false));
});

describe('defineSchedule (ADR-0026)', () => {
  it('returns a frozen schedule with a normalised cron and the parsed payload', () => {
    const schedule = defineSchedule({
      id: 'system.noop-hourly',
      job: SYSTEM_NOOP_JOB,
      cron: ' 0   *  * * * ',
      payload: { correlationId: '0195f2a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f' },
      description: 'test',
    });
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(schedule.cron).toBe('0 * * * *');
    // Schema defaults are applied once, at definition time.
    expect(schedule.payload).toEqual({
      correlationId: '0195f2a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f',
      workMs: 0,
    });
    expect(SCHEDULE_TIME_ZONE).toBe('UTC');
  });

  it.each(['purge', 'Identity.purge', 'identity.', 'identity purge', 'identity.purge:daily'])(
    'rejects schedule id %j',
    (id) => {
      expect(() =>
        defineSchedule({ id, job: EMPTY_JOB, cron: '0 0 * * *', payload: {}, description: '' }),
      ).toThrow(/Invalid schedule id/);
    },
  );

  it('rejects an unsupported cron expression', () => {
    expect(() =>
      defineSchedule({
        id: 'test.bad-cron',
        job: EMPTY_JOB,
        cron: '0 0 * * MON',
        payload: {},
        description: '',
      }),
    ).toThrow(/Invalid cron/);
  });

  it('rejects a payload the job schema refuses, naming fields but not values', () => {
    const attempt = () =>
      defineSchedule({
        id: 'test.bad-payload',
        job: SYSTEM_NOOP_JOB,
        cron: '0 0 * * *',
        payload: { correlationId: 'secret-not-a-uuid' },
        description: '',
      });
    expect(attempt).toThrow(/correlationId/);
    expect(attempt).not.toThrow(/secret-not-a-uuid/);
    expect(() =>
      defineSchedule({
        id: 'test.extra-field',
        job: EMPTY_JOB,
        cron: '0 0 * * *',
        payload: { userId: 'x' } as never,
        description: '',
      }),
    ).toThrow(/rejects/);
  });
});
