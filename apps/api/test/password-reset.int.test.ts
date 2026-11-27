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
import type * as IdentityApi from '../src/modules/identity/index.js';
import { RespClient } from './integration/redis-resp.js';

// Integration (backlog P2-05, ADR-0022): password recovery end to end on real PostgreSQL and Redis
// — the API (`createApp` + AppModule) answers the request and queues the reset email in the
// background, a real worker context (`WorkerModule`) issues the token and "sends" through an
// in-memory transport, and the token from the email resets the password through the API. Queue and
// rate-limit keys live under this run's prefix (global setup), the database is the run's own.
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');

const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new passphrase 2026';
const ORIGIN = 'http://localhost:3000'; // CORS_ORIGINS default
let seq = 0;
const uniqueEmail = (label: string) => `reset.${label}.${Date.now()}.${++seq}@example.test`;
let ipSeq = 0;
/** A fresh client address (TEST-NET-2) per request group, so the `auth` class never interferes. */
const freshIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;
const sha256 = (token: string) => new Uint8Array(createHash('sha256').update(token).digest());
const TOKEN_IN_LINK = /\/auth\/reset-password#token=([A-Za-z0-9_-]{43})/;

describe('password recovery (real PostgreSQL + Redis + worker)', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let db: PrismaClient;
  let redis: RespClient;
  let mail: InstanceType<typeof MailApi.MemoryMailTransport>;
  let recovery: IdentityApi.PasswordRecoveryService;
  const lines: string[] = [];
  const http = () => request(app.getHttpServer());
  const post = (path: string, ip = freshIp()) =>
    http().post(`/api/v1/auth/${path}`).set('X-Forwarded-For', ip).set('Origin', ORIGIN);

  const register = (email: string, locale: 'en' | 'fa' = 'fa') =>
    post('register').send({ email, password: OLD_PASSWORD, locale, timezone: 'Asia/Tehran' });
  const requestReset = (email: string) => post('password-reset/request').send({ email });
  const resetWith = (token: string, password = NEW_PASSWORD) =>
    post('password-reset/confirm').send({ token, password });
  const login = (email: string, password: string) => post('login').send({ email, password });

  async function signIn(email: string, password = OLD_PASSWORD): Promise<string> {
    const res = await login(email, password).expect(200);
    return (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  }
  const sessionOf = (cookie: string) => http().get('/api/v1/auth/session').set('Cookie', cookie);

  /** Waits until `count` messages with `template` reached `email` and returns them. */
  async function mailTo(email: string, template: string, count = 1, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    const matching = () => mail.to(email).filter((m) => m.template === template);
    while (Date.now() < deadline) {
      if (matching().length >= count) return matching();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`expected ${count} ${template} email(s), got ${matching().length}`);
  }
  const resetEmails = (email: string, count = 1) => mailTo(email, 'identity.password-reset', count);
  const tokenFrom = (text: string) => {
    const match = TOKEN_IN_LINK.exec(text);
    if (!match) throw new Error('no reset link in the email');
    return match[1]!;
  };
  /** Waits for the background request work and the email queue to finish. */
  async function idle() {
    await recovery.settled();
    const { QueueProducer } = await import('../src/queue/index.js');
    const queue = app.get(QueueProducer).queue('email');
    for (let i = 0; i < 400; i++) {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      if ((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) === 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('email queue did not drain');
  }
  /** Registers an account and drops its verification email. */
  async function account(label: string, locale: 'en' | 'fa' = 'fa') {
    const email = uniqueEmail(label);
    await register(email, locale).expect(202);
    await mailTo(email, 'identity.verify-email');
    return email;
  }
  /** Clears the per-address request limit (to issue a second link within a minute). */
  async function clearRequestLimit(email: string) {
    const { keyFor } = await import('../src/modules/identity/login-throttle.js');
    const prefix = `${keyPrefix}reset:password-reset`;
    await redis.command([
      'DEL',
      `${prefix}:cooldown:${keyFor(email)}`,
      `${prefix}:hour:${keyFor(email)}`,
    ]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.RATE_LIMIT_PREFIX = `${keyPrefix}reset`;
    process.env.TRUST_PROXY = '1';
    const { AppModule } = await import('../src/app.module.js');
    const { createApp } = await import('../src/app.factory.js');
    const { JsonLogger } = await import('../src/common/logging/json-logger.js');
    const mailApi = await import('../src/mail/index.js');
    const identity = await import('../src/modules/identity/index.js');
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
    recovery = app.get(identity.PasswordRecoveryService);
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

  it('journey: link in the account language → new password; every session ends; notice sent; old password dead', async () => {
    const email = await account('journey', 'fa');
    const phone = await signIn(email);
    const laptop = await signIn(email);
    await sessionOf(phone).expect(200);

    const res = await requestReset(email.toUpperCase()).expect(202);
    expect(res.body).toEqual({ status: 'accepted' });
    const [message] = await resetEmails(email);
    expect(message).toMatchObject({ locale: 'fa', to: email });
    expect(message!.html).toContain('dir="rtl"');
    const token = tokenFrom(message!.text);
    expect(message!.text).toContain(`http://localhost:3000/fa/auth/reset-password#token=${token}`);

    // Stored: only the hash, bound to the address, expiring in 30 minutes.
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
    const rows = await db.userToken.findMany({
      where: { userId: user.id, purpose: 'password_reset' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email, consumedAt: null });
    expect(Buffer.from(rows[0]!.tokenHash).equals(Buffer.from(sha256(token)))).toBe(true);
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime()).toBe(30 * 60_000);

    const done = await resetWith(token).expect(200);
    expect(done.body).toEqual({ status: 'password-reset' });
    // Does not sign in.
    expect(done.headers['set-cookie']).toBeUndefined();

    // Every session ended, with the reason recorded.
    await sessionOf(phone).expect(401);
    await sessionOf(laptop).expect(401);
    const sessions = await db.userSession.findMany({ where: { userId: user.id } });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const s of sessions) expect(s.revokedReason).toBe('password_changed');

    // Token consumed; the address now counts as verified (the link proved control of it).
    const after = await db.user.findUniqueOrThrow({ where: { email } });
    expect(after.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await db.userToken.count({ where: { userId: user.id, consumedAt: null } })).toBe(0);
    const credential = await db.userPasswordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(credential.passwordHash).toMatch(/^\$argon2id\$v=19\$/);

    // "Your password was changed" notice, in the account language, without a token.
    const [notice] = await mailTo(email, 'identity.password-changed');
    expect(notice).toMatchObject({ locale: 'fa' });
    expect(notice!.text).toContain('http://localhost:3000/fa/auth/sign-in');
    expect(notice!.text).not.toMatch(/token=/);

    // Old password fails, new one works and reports the verified address.
    expect((await login(email, OLD_PASSWORD).expect(401)).body.error.code).toBe(
      'INVALID_CREDENTIALS',
    );
    const ok = await login(email, NEW_PASSWORD).expect(200);
    expect(ok.body.user.emailVerified).toBe(true);

    // Single use.
    expect((await resetWith(token, 'yet another passphrase').expect(400)).body.error.code).toBe(
      'INVALID_TOKEN',
    );
    await login(email, NEW_PASSWORD).expect(200);
  });

  it('identical 202 for unknown, deleted and registered addresses; only the registered one gets mail', async () => {
    const registered = await account('known', 'en');
    const unknown = uniqueEmail('unknown');
    const deleted = uniqueEmail('deleted');
    await db.user.create({
      data: {
        email: deleted,
        deletedAt: new Date(),
        preference: { create: { locale: 'en', timezone: 'UTC' } },
        passwordCredential: { create: { passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$x$y' } },
      },
    });
    const bodies = [];
    for (const email of [registered, unknown, deleted]) {
      const res = await requestReset(email).expect(202);
      bodies.push({ body: res.body, type: res.headers['content-type'] });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    await resetEmails(registered);
    await idle();
    expect(mail.to(unknown)).toHaveLength(0);
    expect(mail.to(deleted)).toHaveLength(0);
    const deletedUser = await db.user.findUniqueOrThrow({ where: { email: deleted } });
    expect(await db.userToken.count({ where: { userId: deletedUser.id } })).toBe(0);
  });

  it('per-address limit: repeated requests are accepted but send at most one email a minute', async () => {
    const email = await account('flood', 'en');
    for (let i = 0; i < 4; i++) await requestReset(email).expect(202);
    await resetEmails(email);
    await idle();
    expect(mail.to(email).filter((m) => m.template === 'identity.password-reset')).toHaveLength(1);
    // The limit is per address, counted for unknown addresses too (no difference to observe).
    const unknown = uniqueEmail('flood.unknown');
    await requestReset(unknown).expect(202);
    await idle();
    const { keyFor } = await import('../src/modules/identity/login-throttle.js');
    const ttl = await redis.command([
      'PTTL',
      `${keyPrefix}reset:password-reset:cooldown:${keyFor(unknown)}`,
    ]);
    expect(Number(ttl)).toBeGreaterThan(0);
    // The key never contains the address.
    const keys = (await redis.command(['KEYS', `${keyPrefix}reset:password-reset:*`])) as string[];
    expect(keys.join('\n')).not.toContain('example.test');
  });

  it('newest link only; expired and wrong-address links are dead; a bad password keeps the link usable', async () => {
    const email = await account('links', 'en');
    await requestReset(email).expect(202);
    const first = tokenFrom((await resetEmails(email))[0]!.text);
    await clearRequestLimit(email);
    await requestReset(email).expect(202);
    const second = tokenFrom((await resetEmails(email, 2))[1]!.text);
    expect(second).not.toBe(first);
    expect((await resetWith(first).expect(400)).body.error.code).toBe('INVALID_TOKEN');

    // Policy violation: 400 VALIDATION_FAILED, token still usable, nothing changed.
    const weak = await resetWith(second, 'short').expect(400);
    expect(weak.body.error.code).toBe('VALIDATION_FAILED');
    await login(email, OLD_PASSWORD).expect(200);

    // Expired.
    await db.userToken.updateMany({
      where: { tokenHash: sha256(second) },
      data: { createdAt: new Date(Date.now() - 31 * 60_000), expiresAt: new Date(Date.now() - 1) },
    });
    expect((await resetWith(second).expect(400)).body.error.code).toBe('INVALID_TOKEN');

    // Address changed after the link was sent.
    const moved = await account('moved', 'en');
    await requestReset(moved).expect(202);
    const movedToken = tokenFrom((await resetEmails(moved))[0]!.text);
    await db.user.update({ where: { email: moved }, data: { email: uniqueEmail('moved.new') } });
    expect((await resetWith(movedToken).expect(400)).body.error.code).toBe('INVALID_TOKEN');
  });

  it('a deleted account cannot use a link it was sent', async () => {
    const email = await account('deleted.later', 'en');
    await requestReset(email).expect(202);
    const token = tokenFrom((await resetEmails(email))[0]!.text);
    await db.user.update({ where: { email }, data: { deletedAt: new Date() } });
    expect((await resetWith(token).expect(400)).body.error.code).toBe('INVALID_TOKEN');
  });

  it('of concurrent resets with the same token exactly one succeeds', async () => {
    const email = await account('race', 'en');
    await requestReset(email).expect(202);
    const token = tokenFrom((await resetEmails(email))[0]!.text);
    const results = await Promise.all([
      resetWith(token, 'first concurrent passphrase'),
      resetWith(token, 'second concurrent passphrase'),
      resetWith(token, 'third concurrent passphrase'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    await idle();
    expect(mail.to(email).filter((m) => m.template === 'identity.password-changed')).toHaveLength(
      1,
    );
  });

  it('a reset clears the sign-in lockout of the address', async () => {
    const email = await account('lockout', 'en');
    for (let i = 0; i < 5; i++) await login(email, 'wrong password!!').expect(401);
    const locked = await login(email, OLD_PASSWORD).expect(429);
    expect(locked.body.error.details.policy).toBe('login-account');
    await requestReset(email).expect(202);
    await resetWith(tokenFrom((await resetEmails(email))[0]!.text)).expect(200);
    await login(email, NEW_PASSWORD).expect(200);
  });

  it('works for an account without a password yet (creates the credential)', async () => {
    const email = uniqueEmail('nopassword');
    await db.user.create({
      data: { email, preference: { create: { locale: 'en', timezone: 'UTC' } } },
    });
    await requestReset(email).expect(202);
    await resetWith(tokenFrom((await resetEmails(email))[0]!.text)).expect(200);
    await login(email, NEW_PASSWORD).expect(200);
  });

  it('never logs addresses, tokens, links or passwords (API and worker)', async () => {
    const email = await account('logs', 'en');
    lines.length = 0;
    await requestReset(email).expect(202);
    await requestReset(uniqueEmail('logs.unknown')).expect(202);
    const token = tokenFrom((await resetEmails(email))[0]!.text);
    await resetWith(token).expect(200);
    await resetWith(token).expect(400);
    await mailTo(email, 'identity.password-changed');
    await idle();
    await new Promise((r) => setTimeout(r, 50));
    const text = lines.join('\n');
    expect(text).toContain('"msg":"password reset request"');
    expect(text).toContain('"outcome":"no-account"');
    expect(text).toContain('"template":"identity.password-reset"');
    expect(text).toContain('"msg":"password reset"');
    for (const secret of [email, token, 'reset-password#', 'example.test', NEW_PASSWORD]) {
      expect(text).not.toContain(secret);
    }
  });
});
