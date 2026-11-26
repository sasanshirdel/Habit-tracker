import 'reflect-metadata';
import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type * as MailApi from '../src/mail/index.js';
import { RespClient } from './integration/redis-resp.js';

// Integration (backlog P2-04, ADR-0021): email verification end to end on real PostgreSQL and
// Redis — the API (`createApp` + AppModule) queues the email job, a real worker context
// (`WorkerModule`) consumes it from the `email` queue and "sends" through an in-memory transport,
// and the token from the email is confirmed through the API. Queue and rate-limit keys live under
// this run's prefix (global setup), the database is the run's throwaway one.
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'http://localhost:3000'; // CORS_ORIGINS default
let seq = 0;
const uniqueEmail = (label: string) => `verify.${label}.${Date.now()}.${++seq}@example.test`;
let ipSeq = 0;
/** A fresh client address (TEST-NET-3) per request group, so the `auth` class never interferes. */
const freshIp = () => `203.0.113.${(++ipSeq % 250) + 1}`;
const sha256 = (token: string) => new Uint8Array(createHash('sha256').update(token).digest());
const TOKEN_IN_LINK = /\/auth\/verify-email#token=([A-Za-z0-9_-]{43})/;

describe('email verification (real PostgreSQL + Redis + worker)', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let db: PrismaClient;
  let redis: RespClient;
  let mail: InstanceType<typeof MailApi.MemoryMailTransport>;
  const lines: string[] = [];
  const http = () => request(app.getHttpServer());
  const post = (path: string, ip = freshIp()) =>
    http().post(`/api/v1/auth/${path}`).set('X-Forwarded-For', ip).set('Origin', ORIGIN);

  const register = (email: string, locale: 'en' | 'fa' = 'fa') =>
    post('register').send({ email, password: PASSWORD, locale, timezone: 'Asia/Tehran' });
  const confirm = (token: string) => post('verification/confirm').send({ token });

  async function signIn(email: string): Promise<{ cookie: string; csrf: string }> {
    const res = await post('login').send({ email, password: PASSWORD }).expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    return { cookie, csrf: res.body.csrfToken as string };
  }
  const resend = (session: { cookie: string; csrf: string }) =>
    post('verification/resend').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);

  /** Waits until `count` messages reached `email` and returns them. */
  async function mailTo(email: string, count = 1, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sent = mail.to(email);
      if (sent.length >= count) return sent;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`expected ${count} email(s) to ${email}, got ${mail.to(email).length}`);
  }
  const tokenFrom = (text: string) => {
    const match = TOKEN_IN_LINK.exec(text);
    if (!match) throw new Error('no verification link in the email');
    return match[1]!;
  };
  /** Waits for the email queue to be idle (so "nothing was sent" is a real observation). */
  async function queueDrained() {
    const { QueueProducer } = await import('../src/queue/index.js');
    const queue = app.get(QueueProducer).queue('email');
    for (let i = 0; i < 400; i++) {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      if (counts.waiting + counts.active + counts.delayed === 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('email queue did not drain');
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.RATE_LIMIT_PREFIX = `${keyPrefix}verify`;
    process.env.TRUST_PROXY = '1';
    const { AppModule } = await import('../src/app.module.js');
    const { createApp } = await import('../src/app.factory.js');
    const { JsonLogger } = await import('../src/common/logging/json-logger.js');
    const mailApi = await import('../src/mail/index.js');
    const { WorkerModule } = await import('../src/worker/index.js');
    const logger = new JsonLogger({
      service: 'api',
      level: 'trace',
      format: 'json',
      includeErrorMessages: false,
      write: (line) => lines.push(line),
    });
    app = await createApp(AppModule, { logger });
    await app.init();
    mail = new mailApi.MemoryMailTransport();
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(mailApi.MAIL_TRANSPORT)
      .useValue(mail)
      .compile();
    worker.useLogger(logger);
    await worker.init();
    const { RedisConnection } = await import('../src/queue/index.js');
    const connection = app.get(RedisConnection);
    for (let i = 0; i < 100 && !connection.isReady; i++)
      await new Promise((r) => setTimeout(r, 50));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    redis = await RespClient.connect(redisUrl);
  }, 60_000);

  beforeEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    const { shutdownWorker } = await import('../src/worker/index.js');
    if (worker) await shutdownWorker(worker);
    await app?.close();
    await db?.$disconnect();
    await redis?.quit();
    delete process.env.TRUST_PROXY;
  });

  it('sign-up emails a link (account language, RTL); the link verifies once; sign-in then says verified', async () => {
    const email = uniqueEmail('journey');
    await register(email, 'fa').expect(202);
    const [message] = await mailTo(email);
    expect(message).toMatchObject({ template: 'identity.verify-email', locale: 'fa', to: email });
    expect(message!.html).toContain('dir="rtl"');
    const token = tokenFrom(message!.text);
    expect(message!.text).toContain(`http://localhost:3000/fa/auth/verify-email#token=${token}`);

    // Stored: only the hash, for this address, expiring in 24 h.
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const rows = await db.userToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'email_verification', email, consumedAt: null });
    expect(Buffer.from(rows[0]!.tokenHash).equals(Buffer.from(sha256(token)))).toBe(true);
    const lifetime = rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime();
    expect(lifetime).toBe(24 * 60 * 60 * 1000);

    // Unverified accounts can sign in (ADR-0021 interim policy) and see that they are unverified.
    const before = await signIn(email);
    const session = await http().get('/api/v1/auth/session').set('Cookie', before.cookie);
    expect(session.body.user.emailVerified).toBe(false);

    const ok = await confirm(token).expect(200);
    expect(ok.body).toEqual({ status: 'verified' });
    expect((await db.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).toBeInstanceOf(
      Date,
    );
    const consumed = await db.userToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(consumed.consumedAt).toBeInstanceOf(Date);

    // Single use.
    const again = await confirm(token).expect(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');

    // The existing session sees the change at once; a new sign-in reports it too.
    const after = await http().get('/api/v1/auth/session').set('Cookie', before.cookie).expect(200);
    expect(after.body.user.emailVerified).toBe(true);
    const login = await post('login').send({ email, password: PASSWORD }).expect(200);
    expect(login.body.user.emailVerified).toBe(true);
  });

  it('sends at most one registration email per account per window, however often the form is sent', async () => {
    const email = uniqueEmail('repeat');
    for (let i = 0; i < 3; i++) await register(email).expect(202);
    await mailTo(email);
    await queueDrained();
    expect(mail.to(email)).toHaveLength(1);
  });

  it('a taken, verified address gets a notice instead (no token); a deleted account gets nothing', async () => {
    const verified = uniqueEmail('taken');
    await register(verified, 'en').expect(202);
    await mailTo(verified);
    await confirm(tokenFrom(mail.to(verified)[0]!.text)).expect(200);
    // Next window: the job id of the first registration email no longer deduplicates.
    const { registrationEmailJobId } = await import('../src/modules/identity/index.js');
    const user = await db.user.findUniqueOrThrow({ where: { email: verified } });
    const { QueueProducer } = await import('../src/queue/index.js');
    const { VERIFICATION_EMAIL_JOB } = await import('../src/modules/identity/index.js');
    const producer = app.get(QueueProducer);
    await producer.enqueue(
      VERIFICATION_EMAIL_JOB,
      { userId: user.id, reason: 'registration' },
      { jobId: registrationEmailJobId(user.id, Date.now() + 60 * 60 * 1000) },
    );
    const [, notice] = await mailTo(verified, 2);
    expect(notice).toMatchObject({ template: 'identity.already-registered', locale: 'en' });
    expect(notice!.text).toContain('http://localhost:3000/en/auth/sign-in');
    expect(notice!.text).not.toMatch(/token/i);
    expect(await db.userToken.count({ where: { userId: user.id, consumedAt: null } })).toBe(0);

    const deleted = uniqueEmail('deleted');
    await db.user.create({
      data: {
        email: deleted,
        deletedAt: new Date(),
        preference: { create: { locale: 'en', timezone: 'UTC' } },
      },
    });
    const res = await register(deleted).expect(202);
    expect(res.body).toEqual({ status: 'accepted' });
    await queueDrained();
    expect(mail.to(deleted)).toHaveLength(0);
  });

  it('resend: a new link replaces the old one; limited per account (429 verification-email); no-op once verified', async () => {
    const email = uniqueEmail('resend');
    await register(email).expect(202);
    const first = tokenFrom((await mailTo(email))[0]!.text);
    const session = await signIn(email);

    const accepted = await resend(session).expect(202);
    expect(accepted.body).toEqual({ status: 'accepted' });
    const second = tokenFrom((await mailTo(email, 2))[1]!.text);
    expect(second).not.toBe(first);

    const tooSoon = await resend(session).expect(429);
    expect(tooSoon.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { policy: 'verification-email' },
    });
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(tooSoon.headers['retry-after'])).toBeLessThanOrEqual(60);

    // The superseded link is dead, the newest one works.
    expect((await confirm(first).expect(400)).body.error.code).toBe('INVALID_TOKEN');
    await confirm(second).expect(200);

    // Verified: 202, nothing queued, no cooldown consumed.
    const fresh = await signIn(email);
    await resend(fresh).expect(202);
    await queueDrained();
    expect(mail.to(email)).toHaveLength(2);
  });

  it('resend needs the session CSRF token', async () => {
    const email = uniqueEmail('resend.csrf');
    await register(email).expect(202);
    const session = await signIn(email);
    const res = await post('verification/resend').set('Cookie', session.cookie).expect(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects expired tokens and tokens for an address the account no longer has', async () => {
    const expired = uniqueEmail('expired');
    await register(expired).expect(202);
    const expiredToken = tokenFrom((await mailTo(expired))[0]!.text);
    await db.userToken.updateMany({
      where: { tokenHash: sha256(expiredToken) },
      data: {
        createdAt: new Date(Date.now() - 25 * 3_600_000),
        expiresAt: new Date(Date.now() - 1),
      },
    });
    expect((await confirm(expiredToken).expect(400)).body.error.code).toBe('INVALID_TOKEN');

    const moved = uniqueEmail('moved');
    await register(moved).expect(202);
    const movedToken = tokenFrom((await mailTo(moved))[0]!.text);
    await db.user.update({ where: { email: moved }, data: { email: uniqueEmail('moved.new') } });
    expect((await confirm(movedToken).expect(400)).body.error.code).toBe('INVALID_TOKEN');
    const user = await db.user.findFirstOrThrow({
      where: { tokens: { some: { tokenHash: sha256(movedToken) } } },
    });
    expect(user.emailVerifiedAt).toBeNull();
  });

  it('of two concurrent confirmations with the same token exactly one succeeds', async () => {
    const email = uniqueEmail('race');
    await register(email).expect(202);
    const token = tokenFrom((await mailTo(email))[0]!.text);
    const results = await Promise.all([confirm(token), confirm(token), confirm(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
  });

  it('retries a failed delivery and still sends exactly one working link', async () => {
    const email = uniqueEmail('retry');
    mail.failNext = 1;
    await register(email).expect(202);
    const [message] = await mailTo(email, 1, 20_000);
    await confirm(tokenFrom(message!.text)).expect(200);
  }, 30_000);

  it('never logs email addresses, tokens or links (API and worker)', async () => {
    const email = uniqueEmail('logs');
    await register(email).expect(202);
    const token = tokenFrom((await mailTo(email))[0]!.text);
    await confirm(token).expect(200);
    await confirm(token).expect(400);
    await new Promise((r) => setTimeout(r, 50));
    const text = lines.join('\n');
    expect(text).toContain('"template":"identity.verify-email"');
    expect(text).toContain('"msg":"verification email job"');
    for (const secret of [email, token, 'verify-email#', 'example.test']) {
      expect(text).not.toContain(secret);
    }
  });
});
