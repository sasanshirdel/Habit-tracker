import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as QueueApi from '@habit/api/queue';

// Integration (backlog P1-03): the built worker runs as a real OS process; this test plays the
// API's role as producer. Proves "enqueued by the API, processed by the worker" across processes
// and graceful shutdown on SIGTERM.
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  throw new Error(
    'Worker integration tests need DATABASE_URL and REDIS_URL (see apps/worker/README.md).',
  );
}

const keyPrefix = `habit:it:w${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}:`;
const queuePrefix = `${keyPrefix}q`;
const mainJs = fileURLToPath(new URL('../dist/main.js', import.meta.url));

interface RunningWorker {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function startWorker(env: Record<string, string> = {}): RunningWorker {
  let output = '';
  const child = spawn(process.execPath, [mainJs], {
    env: {
      ...process.env,
      NO_COLOR: '1',
      QUEUE_PREFIX: queuePrefix,
      WORKER_SHUTDOWN_TIMEOUT_MS: '15000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, output: () => output, exited };
}

/** Structured logging (P1-07): every line the worker prints is one JSON object. */
function jsonLines(output: string): Array<Record<string, unknown>> {
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('worker process (real Redis)', () => {
  let queueApi: typeof QueueApi;
  let producerContext: INestApplicationContext;
  let producer: QueueApi.QueueProducer;

  const jobState = async (id: string) => (await producer.queue('system').getJob(id))?.getState();
  const untilState = (id: string, state: string) =>
    waitFor(
      async () => ((await jobState(id)) === state ? true : undefined),
      `job ${id} → ${state}`,
    );

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = queuePrefix;
    queueApi = await import('@habit/api/queue');
    producerContext = await queueApi.createQueueProducerContext();
    producer = producerContext.get(queueApi.QueueProducer);
    const redis = producerContext.get(queueApi.RedisConnection);
    await waitFor(() => (redis.isReady ? true : undefined), 'producer Redis connection');
  });

  afterAll(async () => {
    if (!producerContext) return;
    // Remove this run's keys (SCAN, never KEYS/FLUSHDB — the Redis may be shared).
    const { client } = producerContext.get(queueApi.RedisConnection);
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await client.del(...keys);
    } while (cursor !== '0');
    await producerContext.close();
  });

  it('processes a job enqueued by a producer, then drains and exits 0 on SIGTERM', async () => {
    const worker = startWorker({ LOG_LEVEL: 'debug' });
    try {
      await waitFor(
        () => (worker.output().includes('Worker started.') ? true : undefined),
        'worker start',
      );

      const quick = await producer.enqueue(queueApi.SYSTEM_NOOP_JOB, {
        correlationId: randomUUID(),
      });
      await untilState(quick.id, 'completed');

      // Graceful shutdown: SIGTERM while a job is in flight → the job completes, then exit 0.
      const slow = await producer.enqueue(queueApi.SYSTEM_NOOP_JOB, {
        correlationId: randomUUID(),
        workMs: 2_000,
      });
      await untilState(slow.id, 'active');
      const signalledAt = Date.now();
      worker.child.kill('SIGTERM');
      const code = await worker.exited;

      expect(code, worker.output()).toBe(0);
      expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(1_000); // waited for the job
      expect(await jobState(slow.id)).toBe('completed');
      expect(worker.output()).toMatch(/Received SIGTERM; draining/);
      expect(worker.output()).toMatch(/All workers drained/);

      // Structured logs: JSON lines from the worker; lines logged by a job handler carry the
      // job's identity (never its payload).
      const records = jsonLines(worker.output());
      expect(records.every((r) => r.service === 'worker' && typeof r.msg === 'string')).toBe(true);
      expect(records.find((r) => r.jobId === quick.id)).toMatchObject({
        level: 'debug',
        context: 'SystemNoopJobHandler',
        jobName: 'system.noop',
        attempt: 1,
      });
    } finally {
      worker.child.kill('SIGKILL');
    }
  });

  it('registers the recurring jobs (ADR-0026) at startup, without blocking or repeating them', async () => {
    const worker = startWorker({ JOB_SCHEDULES_ENABLED: 'true' });
    try {
      await waitFor(
        () => (worker.output().includes('Job schedules synced:') ? true : undefined),
        'schedule sync',
      );
      const system = producer.queue('system');
      expect((await system.getJobSchedulers(0, -1)).map((s) => s.key).sort()).toEqual([
        'habits.deleted-purge-daily',
        'identity.account-purge-daily',
        'identity.retention-cleanup-daily',
      ]);
      expect(await system.getJobScheduler('identity.account-purge-daily')).toMatchObject({
        pattern: '30 23 * * *',
        tz: 'UTC',
      });
      const delayed = (await system.getDelayed(0, -1)).filter((j) => j.id?.startsWith('repeat:'));
      expect(delayed).toHaveLength(3);
      // Logged: schedule ids and cron only.
      expect(worker.output()).toMatch(
        /Job schedules synced: identity\.account-purge-daily \(30 23 \* \* \* UTC\), identity\.retention-cleanup-daily \(45 23 \* \* \* UTC\), habits\.deleted-purge-daily \(55 23 \* \* \* UTC\)/,
      );
      worker.child.kill('SIGTERM');
      expect(await worker.exited).toBe(0);

      // A second start (a redeploy, or another replica) leaves the registered runs alone.
      const again = startWorker({ JOB_SCHEDULES_ENABLED: 'true' });
      try {
        await waitFor(
          () => (again.output().includes('Job schedules synced:') ? true : undefined),
          'schedule sync (second start)',
        );
        const after = (await system.getDelayed(0, -1)).filter((j) => j.id?.startsWith('repeat:'));
        expect(after.map((j) => j.id).sort()).toEqual(delayed.map((j) => j.id).sort());
        again.child.kill('SIGTERM');
        expect(await again.exited).toBe(0);
      } finally {
        again.child.kill('SIGKILL');
      }
    } finally {
      worker.child.kill('SIGKILL');
    }
  });

  it('never prints connection strings or credentials', async () => {
    const worker = startWorker();
    try {
      await waitFor(
        () => (worker.output().includes('Worker started.') ? true : undefined),
        'worker start',
      );
      worker.child.kill('SIGTERM');
      expect(await worker.exited).toBe(0);
      for (const secret of [databaseUrl, redisUrl, new URL(databaseUrl).password]) {
        if (secret) expect(worker.output()).not.toContain(secret);
      }
    } finally {
      worker.child.kill('SIGKILL');
    }
  });

  it('survives Redis being unreachable and still shuts down within the timeout', async () => {
    const worker = startWorker({
      REDIS_URL: 'redis://127.0.0.1:1',
      WORKER_SHUTDOWN_TIMEOUT_MS: '1000',
    });
    try {
      await waitFor(
        () => (worker.output().includes('Worker started.') ? true : undefined),
        'worker start',
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500)); // several reconnect attempts
      expect(worker.child.exitCode).toBeNull(); // no crash on connection errors
      expect(worker.output()).toMatch(/Redis \(worker\) unavailable \(ECONNREFUSED\)/);
      const signalledAt = Date.now();
      worker.child.kill('SIGTERM');
      expect(await worker.exited).toBe(0);
      expect(Date.now() - signalledAt).toBeLessThan(5_000);
    } finally {
      worker.child.kill('SIGKILL');
    }
  });

  it('refuses to start with invalid configuration, naming the variable but not its value', async () => {
    const worker = startWorker({ REDIS_URL: 'http://admin:sup3r-secret@cache.internal:6379' });
    const code = await worker.exited;
    expect(code).toBe(1);
    // Reported by Nest's bootstrap error handler (same as the API), which exits 1.
    expect(worker.output()).toMatch(/Invalid environment configuration/);
    expect(worker.output()).toContain('REDIS_URL');
    expect(worker.output()).not.toContain('sup3r-secret');
    expect(worker.output()).not.toContain('cache.internal');
    // Reported as structured JSON too: the configuration error keeps its (safe) message.
    const records = jsonLines(worker.output());
    expect(records.some((r) => r.level === 'error' || r.level === 'fatal')).toBe(true);
  });
});
