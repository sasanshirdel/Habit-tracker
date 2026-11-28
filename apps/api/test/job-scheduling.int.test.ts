import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type * as IdentityApi from '../src/modules/identity/index.js';
import type * as QueueApi from '../src/queue/index.js';
import type * as WorkerApi from '../src/worker/index.js';

// Integration (ADR-0026): recurring jobs on real Redis and PostgreSQL. Two worker contexts play two
// replicas of the worker process; both register the identity schedules (daily account purge and
// retention clean-up) as BullMQ job schedulers. Proves: the schedulers exist with cron in UTC and
// the right job; replicas and re-syncs never create a second job for the same run; schedulers no
// longer declared are removed; a scheduled run is an ordinary job that reaches its handler and
// does the work; the retention clean-up deletes exactly the rows outside the retention windows.
// Runs under its own queue prefix with schedules switched on (global setup turns them off).
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');

const DAY_MS = 24 * 60 * 60 * 1000;
let seq = 0;
const email = (label: string) => `sched.${label}.${Date.now()}.${++seq}@example.test`;
const hash = () => randomBytes(32);

/** The next 23:30 / 23:45 UTC strictly after `from`. */
function nextUtc(from: number, hour: number, minute: number): number {
  const d = new Date(from);
  const candidate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  return candidate > from ? candidate : candidate + DAY_MS;
}

describe('recurring jobs (real Redis + PostgreSQL + worker)', () => {
  let identity: typeof IdentityApi;
  let queueApi: typeof QueueApi;
  let workerApi: typeof WorkerApi;
  let db: PrismaClient;
  const workers: TestingModule[] = [];
  const previous = {
    queuePrefix: process.env.QUEUE_PREFIX,
    enabled: process.env.JOB_SCHEDULES_ENABLED,
  };

  const system = () => workers[0]!.get(queueApi.QueueProducer).queue('system');
  /** Delayed jobs created by a scheduler (`repeat:<schedulerId>:<runMillis>` ids). */
  async function scheduledJobs(schedulerId: string) {
    const delayed = await system().getDelayed(0, -1);
    return delayed.filter((job) => job.id?.startsWith(`repeat:${schedulerId}:`));
  }

  async function startWorker(): Promise<TestingModule> {
    const moduleRef = await Test.createTestingModule({
      imports: [workerApi.WorkerModule],
    }).compile();
    await moduleRef.init();
    workers.push(moduleRef);
    return moduleRef;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.QUEUE_PREFIX = `${keyPrefix}sched`;
    process.env.JOB_SCHEDULES_ENABLED = 'true';
    // Imported lazily: ConfigModule validates env when the modules are first evaluated.
    identity = await import('../src/modules/identity/index.js');
    queueApi = await import('../src/queue/index.js');
    workerApi = await import('../src/worker/index.js');
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  });

  afterAll(async () => {
    for (const worker of workers.reverse()) {
      await workerApi.shutdownWorker(worker).catch(() => undefined);
    }
    await db?.$disconnect();
    for (const [key, value] of [
      ['QUEUE_PREFIX', previous.queuePrefix],
      ['JOB_SCHEDULES_ENABLED', previous.enabled],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('registers the identity schedules in UTC, once, even with two replicas syncing repeatedly', async () => {
    const before = Date.now();
    const [a, b] = await Promise.all([startWorker(), startWorker()]);
    await Promise.all([
      a.get(workerApi.JobScheduleRegistrar).firstSync,
      b.get(workerApi.JobScheduleRegistrar).firstSync,
    ]);
    // More syncs from both replicas, concurrently: still one scheduler and one next run each.
    await Promise.all([
      a.get(workerApi.JobScheduleRegistrar).sync(),
      b.get(workerApi.JobScheduleRegistrar).sync(),
      a.get(workerApi.JobScheduleRegistrar).sync(),
    ]);

    const schedulers = await system().getJobSchedulers(0, -1);
    expect(schedulers.map((s) => s.key).sort()).toEqual([
      'identity.account-purge-daily',
      'identity.retention-cleanup-daily',
    ]);
    const purge = await system().getJobScheduler('identity.account-purge-daily');
    expect(purge).toMatchObject({
      name: 'identity.account-purge',
      pattern: '30 23 * * *',
      tz: 'UTC',
    });
    expect(purge?.next).toBe(nextUtc(before, 23, 30));
    const retention = await system().getJobScheduler('identity.retention-cleanup-daily');
    expect(retention).toMatchObject({ name: 'identity.retention-cleanup', pattern: '45 23 * * *' });
    expect(retention?.next).toBe(nextUtc(before, 23, 45));

    const purgeRuns = await scheduledJobs('identity.account-purge-daily');
    expect(purgeRuns).toHaveLength(1);
    expect(purgeRuns[0]!.name).toBe('identity.account-purge');
    expect(purgeRuns[0]!.data).toEqual({});
    expect(purgeRuns[0]!.opts.attempts).toBe(3); // the job definition's own retry policy
    expect(await scheduledJobs('identity.retention-cleanup-daily')).toHaveLength(1);
    // Nothing on the email queue.
    const emailQueue = workers[0]!.get(queueApi.QueueProducer).queue('email');
    expect(await emailQueue.getJobSchedulersCount()).toBe(0);
  });

  it('removes a scheduler that is no longer declared (renamed or deleted in code)', async () => {
    await system().upsertJobScheduler(
      'identity.old-name-daily',
      { pattern: '0 1 * * *', tz: 'UTC' },
      { name: 'identity.account-purge', data: {} },
    );
    const result = await workers[0]!.get(workerApi.JobScheduleRegistrar).sync();
    expect(result.removed).toEqual(['identity.old-name-daily']);
    expect(await system().getJobScheduler('identity.old-name-daily')).toBeUndefined();
    expect(await scheduledJobs('identity.old-name-daily')).toHaveLength(0);
  });

  it('a scheduled run is an ordinary job: it reaches the handler, does the work, and the next run is queued once', async () => {
    // Rows past the retention windows (and some inside them) for one account.
    const user = await db.user.create({ data: { email: email('run') } });
    const now = Date.now();
    await db.userSecurityEvent.create({
      data: { userId: user.id, type: 'sign_in', createdAt: new Date(now - 181 * DAY_MS) },
    });
    await db.userSecurityEvent.create({
      data: { userId: user.id, type: 'sign_in', createdAt: new Date(now - DAY_MS) },
    });
    const [run] = await scheduledJobs('identity.retention-cleanup-daily');
    expect(run).toBeDefined();

    await run!.promote(); // "it is 23:45 UTC"
    for (let i = 0; i < 400 && (await run!.getState()) !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await run!.getState()).toBe('completed');
    expect(await db.userSecurityEvent.count({ where: { userId: user.id } })).toBe(1);

    // The scheduler queued exactly one next run (tomorrow); a replica's re-sync leaves it alone
    // (an upsert would re-plan it from "now", i.e. tonight again).
    const resync = await workers[1]!.get(workerApi.JobScheduleRegistrar).sync();
    expect(resync.upserted).toEqual([]);
    expect(resync.unchanged).toContain('identity.retention-cleanup-daily');
    const next = await scheduledJobs('identity.retention-cleanup-daily');
    expect(next).toHaveLength(1);
    expect(next[0]!.id).not.toBe(run!.id);
    expect(next[0]!.timestamp + next[0]!.delay).toBe(nextUtc(now, 23, 45) + DAY_MS);
  });

  it('the account purge also runs from its schedule', async () => {
    const gone = await db.user.create({
      data: { email: email('purge'), deletedAt: new Date(Date.now() - 31 * DAY_MS) },
    });
    const kept = await db.user.create({
      data: { email: email('keep'), deletedAt: new Date(Date.now() - 29 * DAY_MS) },
    });
    const [run] = await scheduledJobs('identity.account-purge-daily');
    await run!.promote();
    for (let i = 0; i < 400 && (await run!.getState()) !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await run!.getState()).toBe('completed');
    expect(await db.user.findUnique({ where: { id: gone.id } })).toBeNull();
    expect(await db.user.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });

  describe('identity retention clean-up', () => {
    it('deletes exactly the rows outside the retention windows, for every account, in batches; idempotent', async () => {
      const service = workers[0]!.get(identity.IdentityRetentionService);
      const now = new Date();
      const t = (days: number, ms = 0) => new Date(now.getTime() - days * DAY_MS - ms);
      const idleMs = identity.SESSION_IDLE_TIMEOUT_MS;
      const absoluteMs = identity.SESSION_ABSOLUTE_LIFETIME_MS;

      // Two inactive accounts: the purge on write never reaches them.
      const users = await Promise.all([
        db.user.create({ data: { email: email('ret-a') } }),
        db.user.create({ data: { email: email('ret-b') } }),
      ]);
      const expected = { events: [] as string[], sessions: [] as string[], tokens: [] as string[] };
      for (const user of users) {
        const event = (createdAt: Date) =>
          db.userSecurityEvent.create({ data: { userId: user.id, type: 'sign_in', createdAt } });
        await event(t(181));
        await event(t(180, 60_000));
        expected.events.push((await event(t(179))).id, (await event(t(0))).id);

        const session = (data: {
          createdAt: Date;
          lastUsedAt: Date;
          expiresAt: Date;
          revokedAt?: Date;
        }) =>
          db.userSession.create({
            data: {
              userId: user.id,
              tokenHash: hash(),
              ...data,
              ...(data.revokedAt ? { revokedReason: 'sign_out' as const } : {}),
            },
          });
        // Deleted: revoked 31 days ago; expired 31 days ago; idle-expired 31 days ago.
        await session({ createdAt: t(40), lastUsedAt: t(35), expiresAt: t(-10), revokedAt: t(31) });
        await session({
          createdAt: new Date(t(31).getTime() - absoluteMs),
          lastUsedAt: t(31),
          expiresAt: t(31),
        });
        await session({
          createdAt: t(60),
          lastUsedAt: new Date(t(31).getTime() - idleMs),
          expiresAt: t(-1),
        });
        // Kept: revoked 29 days ago; expired 29 days ago; active.
        expected.sessions.push(
          (
            await session({
              createdAt: t(40),
              lastUsedAt: t(35),
              expiresAt: t(-10),
              revokedAt: t(29),
            })
          ).id,
          (
            await session({
              createdAt: new Date(t(29).getTime() - absoluteMs),
              lastUsedAt: t(29),
              expiresAt: t(29),
            })
          ).id,
          (await session({ createdAt: t(1), lastUsedAt: t(0), expiresAt: t(-29) })).id,
        );

        const token = (expiresAt: Date, consumedAt?: Date) =>
          db.userToken.create({
            data: {
              userId: user.id,
              purpose: 'password_reset',
              tokenHash: hash(),
              createdAt: new Date(expiresAt.getTime() - 30 * 60_000),
              expiresAt,
              ...(consumedAt ? { consumedAt } : {}),
            },
          });
        await token(t(0, 1_000)); // expired a second ago
        await token(t(2), t(2, 60_000)); // used and expired
        expected.tokens.push(
          (await token(t(-0.01))).id, // still valid
          (await token(t(-0.01), t(0))).id, // used, not yet expired
        );
      }

      // Other test files share the database, so their old rows may be deleted too: at least ours.
      const result = await service.cleanUp(now, 2);
      expect(result.securityEvents).toBeGreaterThanOrEqual(4);
      expect(result.sessions).toBeGreaterThanOrEqual(6);
      expect(result.tokens).toBeGreaterThanOrEqual(4);
      const where = { where: { userId: { in: users.map((u) => u.id) } } };
      const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
      expect(ids(await db.userSecurityEvent.findMany(where))).toEqual(expected.events.sort());
      expect(ids(await db.userSession.findMany(where))).toEqual(expected.sessions.sort());
      expect(ids(await db.userToken.findMany(where))).toEqual(expected.tokens.sort());

      expect(await service.cleanUp(now, 2)).toEqual({ securityEvents: 0, sessions: 0, tokens: 0 });
    });
  });
});
