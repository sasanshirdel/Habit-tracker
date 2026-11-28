import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type * as MailApi from '../src/mail/index.js';
import type * as IdentityApi from '../src/modules/identity/index.js';
import type * as QueueApi from '../src/queue/index.js';

// Integration (backlog P2-10, ADR-0025): data export, account deletion, restore and purge end to
// end on real PostgreSQL and Redis — the API (`createApp` + AppModule: AuthGuard, CSRF, rate
// limiter, validation, error envelope) plus a real worker context (`WorkerModule`) that sends the
// "account deleted" email through an in-memory transport and runs the purge job. Queue and
// rate-limit keys live under this run's prefix, the database is the run's own.
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'http://localhost:3000'; // CORS_ORIGINS default
const DAY_MS = 24 * 60 * 60 * 1000;
let seq = 0;
const uniqueEmail = (label: string) => `privacy.${label}.${Date.now()}.${++seq}@example.test`;
let ipSeq = 0;
/** A fresh client address (TEST-NET-1) per request group, so the `auth` class never interferes. */
const freshIp = () => `192.0.2.${(++ipSeq % 250) + 1}`;
const TOKEN_IN_LINK = /\/auth\/restore-account#token=([A-Za-z0-9_-]{43})/;

interface Signed {
  cookie: string;
  csrf: string;
}

describe('data export and account deletion (real PostgreSQL + Redis + worker)', () => {
  let app: INestApplication;
  let worker: TestingModule;
  let db: PrismaClient;
  let mail: InstanceType<typeof MailApi.MemoryMailTransport>;
  let identity: typeof IdentityApi;
  let queueApi: typeof QueueApi;
  const lines: string[] = [];
  const http = () => request(app.getHttpServer());
  const post = (path: string) =>
    http().post(`/api/v1${path}`).set('X-Forwarded-For', freshIp()).set('Origin', ORIGIN);

  const register = (email: string, locale: 'en' | 'fa' = 'en', password = PASSWORD) =>
    post('/auth/register').send({ email, password, locale, timezone: 'Asia/Tehran' });
  async function account(label: string, locale: 'en' | 'fa' = 'en'): Promise<string> {
    const email = uniqueEmail(label);
    await register(email, locale).expect(202);
    await mailTo(email, 'identity.verify-email');
    return email;
  }
  const login = (email: string, password = PASSWORD) =>
    post('/auth/login').send({ email, password });
  async function signIn(email: string): Promise<Signed> {
    const res = await login(email).expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    return { cookie, csrf: res.body.csrfToken as string };
  }
  const authed = (method: 'post' | 'patch', path: string, who: Signed) => {
    const server = http();
    const req = method === 'post' ? server.post(`/api/v1${path}`) : server.patch(`/api/v1${path}`);
    return req.set('Cookie', who.cookie).set('Origin', ORIGIN).set('X-CSRF-Token', who.csrf);
  };
  const sessionOf = (who: Signed) => http().get('/api/v1/auth/session').set('Cookie', who.cookie);
  const exportData = (who: Signed) => authed('post', '/account/export', who).send();
  const deleteAccount = (who: Signed, password = PASSWORD) =>
    authed('post', '/account/deletion', who).send({ password });
  const restore = (token: string) => post('/auth/account-restore').send({ token });

  async function mailTo(email: string, template: string, count = 1, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    const matching = () => mail.to(email).filter((m) => m.template === template);
    while (Date.now() < deadline) {
      if (matching().length >= count) return matching();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`expected ${count} ${template} email(s), got ${matching().length}`);
  }
  const tokenFrom = (text: string) => {
    const match = TOKEN_IN_LINK.exec(text);
    if (!match) throw new Error('no restore link in the email');
    return match[1]!;
  };
  /** Waits until a queue has nothing waiting, active or delayed. */
  async function idle(name: 'email' | 'system') {
    const queue = app.get(queueApi.QueueProducer).queue(name);
    for (let i = 0; i < 400; i++) {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
      if ((counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) === 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${name} queue did not drain`);
  }
  const userOf = (email: string) => db.user.findUnique({ where: { email } });
  const eventTypes = async (userId: string) =>
    (await db.userSecurityEvent.findMany({ where: { userId }, orderBy: { id: 'asc' } })).map(
      (e) => e.type,
    );
  /** Deletes an account through the API and returns the restore token from its email. */
  async function deleteAndGetToken(email: string): Promise<string> {
    const who = await signIn(email);
    await deleteAccount(who).expect(202);
    const [message] = await mailTo(email, 'identity.account-deleted');
    return tokenFrom(message!.text);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.RATE_LIMIT_PREFIX = `${keyPrefix}privacy`;
    process.env.TRUST_PROXY = '1';
    const { AppModule } = await import('../src/app.module.js');
    const { createApp } = await import('../src/app.factory.js');
    const { JsonLogger } = await import('../src/common/logging/json-logger.js');
    const mailApi = await import('../src/mail/index.js');
    identity = await import('../src/modules/identity/index.js');
    queueApi = await import('../src/queue/index.js');
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
    const connection = app.get(queueApi.RedisConnection);
    for (let i = 0; i < 100 && !connection.isReady; i++)
      await new Promise((r) => setTimeout(r, 50));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  }, 60_000);

  beforeEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    const { shutdownWorker } = await import('../src/worker/index.js');
    if (worker) await shutdownWorker(worker);
    await app?.close();
    await db?.$disconnect();
    delete process.env.TRUST_PROXY;
  });

  describe('POST /account/export', () => {
    it('returns all of the user’s own data as an attachment, without secrets, and logs none of it', async () => {
      const email = await account('export', 'fa');
      const other = await account('export-other');
      const who = await signIn(email);
      await signIn(other);
      const displayName = 'Export Probe Ada';
      await authed('patch', '/account/profile', who).send({ displayName }).expect(200);

      const res = await exportData(who).expect(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="habit-tracker-data-\d{4}-\d{2}-\d{2}\.json"$/,
      );
      expect(res.headers['cache-control']).toBe('no-store');

      const doc = res.body;
      expect(doc).toMatchObject({
        format: 'habit-tracker.user-data-export',
        version: 1,
        exportedAt: expect.any(String),
      });
      // One section per registered module, sorted (P3-01 added `habits`, ADR-0028).
      expect(Object.keys(doc.sections)).toEqual(['account', 'habits']);
      expect(doc.sections.habits).toEqual({
        categories: [],
        habits: [],
        occurrences: [],
        notes: [],
        pauses: [],
      });
      const user = await userOf(email);
      const data = doc.sections.account;
      expect(data.user).toEqual({
        id: user!.id,
        email,
        emailVerifiedAt: null,
        createdAt: user!.createdAt.toISOString(),
        updatedAt: expect.any(String),
      });
      expect(data.password).toEqual({ set: true, changedAt: expect.any(String) });
      expect(data.profile).toMatchObject({ displayName });
      expect(data.preferences).toMatchObject({
        locale: 'fa',
        timezone: 'Asia/Tehran',
        theme: 'dark',
        calendar: 'solar_hijri',
        weekStart: 'saturday',
      });
      expect(data.sessions).toHaveLength(1);
      expect(Object.keys(data.sessions[0]).sort()).toEqual(
        ['client', 'endReason', 'endedAt', 'expiresAt', 'id', 'lastActiveAt', 'signedInAt'].sort(),
      );
      expect(data.securityEvents.map((e: { type: string }) => e.type)).toEqual(['sign_in']);
      expect(data.emailLinks).toEqual([
        expect.objectContaining({ purpose: 'email_verification', sentTo: email, usedAt: null }),
      ]);

      // Completeness: every stored row of the user is in it.
      expect(data.sessions).toHaveLength(
        await db.userSession.count({ where: { userId: user!.id } }),
      );
      expect(data.emailLinks).toHaveLength(
        await db.userToken.count({ where: { userId: user!.id } }),
      );

      // No secrets, no other user.
      const text = JSON.stringify(doc);
      expect(text).not.toContain('$argon2id$');
      expect(text).not.toMatch(/token_?hash|passwordHash/i);
      expect(text).not.toContain(other);
      const tokenRows = await db.userToken.findMany({ where: { userId: user!.id } });
      for (const row of tokenRows) {
        expect(text).not.toContain(Buffer.from(row.tokenHash).toString('hex'));
        expect(text).not.toContain(Buffer.from(row.tokenHash).toString('base64'));
      }

      // Never logged: not the address, not the name.
      const log = lines.join('\n');
      expect(log).toContain('/account/export');
      expect(log).not.toContain(email);
      expect(log).not.toContain(displayName);

      // Recorded as a security event (after the snapshot, so in the next export).
      expect(await eventTypes(user!.id)).toEqual(['sign_in', 'data_exported']);
      const again = (await exportData(who).expect(200)).body;
      expect(again.sections.account.securityEvents.map((e: { type: string }) => e.type)).toEqual([
        'data_exported',
        'sign_in',
      ]);
    });

    it('needs a session and the CSRF token', async () => {
      const email = await account('export-csrf');
      const who = await signIn(email);
      const none = await post('/account/export').send().expect(401);
      expect(none.body.error.code).toBe('UNAUTHENTICATED');
      const noCsrf = await http()
        .post('/api/v1/account/export')
        .set('Cookie', who.cookie)
        .set('Origin', ORIGIN)
        .send()
        .expect(403);
      expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
      const foreign = await http()
        .post('/api/v1/account/export')
        .set('Cookie', who.cookie)
        .set('Origin', 'https://evil.example')
        .set('X-CSRF-Token', who.csrf)
        .send()
        .expect(403);
      expect(foreign.body.error.code).toBe('CSRF_FAILED');
    });

    it('every table referencing users has an export decision and cascades on hard delete', async () => {
      const { UserDataExportRegistry } = await import('../src/data-export/index.js');
      const covered = app.get(UserDataExportRegistry).coveredTables();
      const refs = await db.$queryRaw<{ table: string; on_delete: string }[]>`
        SELECT c.conrelid::regclass::text AS table, c.confdeltype::text AS on_delete
        FROM pg_constraint c
        WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass`;
      const userTables = ['users', ...refs.map((r) => r.table.replace(/^"|"$/g, ''))].sort();
      expect([...covered.keys()].sort()).toEqual(userTables);
      // 'c' = ON DELETE CASCADE: the purge's single DELETE FROM users erases everything.
      for (const ref of refs)
        expect({ table: ref.table, onDelete: ref.on_delete }).toEqual({
          table: ref.table,
          onDelete: 'c',
        });
    });
  });

  describe('POST /account/deletion', () => {
    it('journey: password confirms → soft delete, every session ends, cannot sign in, email reserved, restore email sent', async () => {
      const email = await account('delete', 'fa');
      const phone = await signIn(email);
      const laptop = await signIn(email);
      const user = (await userOf(email))!;
      // An outstanding reset link must die with the deletion.
      await post('/auth/password-reset/request').send({ email }).expect(202);
      await mailTo(email, 'identity.password-reset');

      // Wrong password: 403, nothing changes, the session still works.
      const wrong = await deleteAccount(phone, 'not my password at all').expect(403);
      expect(wrong.body.error.code).toBe('REAUTHENTICATION_FAILED');
      await sessionOf(phone).expect(200);
      expect((await userOf(email))!.deletedAt).toBeNull();
      // Missing CSRF token: refused before anything else.
      const noCsrf = await http()
        .post('/api/v1/account/deletion')
        .set('Cookie', phone.cookie)
        .set('Origin', ORIGIN)
        .send({ password: PASSWORD })
        .expect(403);
      expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
      // Strict body.
      await authed('post', '/account/deletion', phone)
        .send({ password: PASSWORD, userId: user.id })
        .expect(400);

      const before = Date.now();
      const res = await deleteAccount(phone).expect(202);
      expect(res.body).toEqual({ status: 'deletion-scheduled', purgeAfter: expect.any(String) });
      const purgeAt = Date.parse(res.body.purgeAfter);
      expect(purgeAt - before).toBeGreaterThanOrEqual(30 * DAY_MS - 1_000);
      expect(purgeAt - before).toBeLessThanOrEqual(30 * DAY_MS + 60_000);
      const cleared = (res.headers['set-cookie'] as unknown as string[])[0]!;
      expect(cleared).toMatch(/^__Host-session=;/);

      // Soft-deleted; every session ended with the reason; pending links gone; event recorded.
      const deleted = (await userOf(email))!;
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      await sessionOf(phone).expect(401);
      await sessionOf(laptop).expect(401);
      const sessions = await db.userSession.findMany({ where: { userId: user.id } });
      for (const s of sessions) expect(s.revokedReason).toBe('account_deleted');
      expect(await eventTypes(user.id)).toContain('account_deletion_requested');

      // Confirmation email in the account language with a restore link valid until the purge.
      const [message] = await mailTo(email, 'identity.account-deleted');
      expect(message).toMatchObject({ locale: 'fa', to: email });
      expect(message!.html).toContain('dir="rtl"');
      const token = tokenFrom(message!.text);
      expect(message!.text).toContain(
        `http://localhost:3000/fa/auth/restore-account#token=${token}`,
      );
      const links = await db.userToken.findMany({ where: { userId: user.id, consumedAt: null } });
      expect(links.map((l) => l.purpose)).toEqual(['account_restore']);
      expect(links[0]!.expiresAt.getTime()).toBe(deleted.deletedAt!.getTime() + 30 * DAY_MS);

      // Cannot sign in (indistinguishable from an unknown address), no reset email.
      const denied = await login(email).expect(401);
      expect(denied.body.error.code).toBe('INVALID_CREDENTIALS');
      mail.clear();
      await post('/auth/password-reset/request').send({ email }).expect(202);
      await app.get(identity.PasswordRecoveryService).settled();
      await idle('email');
      expect(mail.to(email)).toHaveLength(0);
      // The address stays reserved during the grace period (ADR-0017): registering again
      // answers the usual 202 and changes nothing.
      await register(email, 'en', 'another password 123').expect(202);
      await idle('email');
      expect(await db.user.count({ where: { email } })).toBe(1);
      expect(mail.to(email)).toHaveLength(0);
      // Nothing personal in the logs.
      expect(lines.join('\n')).not.toContain(email);
    });

    it('wrong passwords count towards the sign-in lockout of the address', async () => {
      const email = await account('lockout');
      const who = await signIn(email);
      for (let i = 0; i < 5; i++) {
        await deleteAccount(who, `wrong password ${i}`).expect(403);
      }
      const locked = await deleteAccount(who).expect(429);
      expect(locked.body.error).toMatchObject({
        code: 'RATE_LIMITED',
        details: { policy: 'login-account' },
      });
      expect((await userOf(email))!.deletedAt).toBeNull();
      await sessionOf(who).expect(200);
    });
  });

  describe('POST /auth/account-restore', () => {
    it('restores the account once; sign-in works again; old sessions stay ended', async () => {
      const email = await account('restore');
      const old = await signIn(email);
      const token = await deleteAndGetToken(email);
      const user = (await userOf(email))!;

      const res = await restore(token).expect(200);
      expect(res.body).toEqual({ status: 'restored' });
      expect(res.headers['set-cookie']).toBeUndefined(); // does not sign in
      expect((await userOf(email))!.deletedAt).toBeNull();
      await sessionOf(old).expect(401);
      expect(await eventTypes(user.id)).toEqual(
        expect.arrayContaining(['account_deletion_requested', 'account_restored']),
      );
      await signIn(email);

      // Single use.
      const again = await restore(token).expect(400);
      expect(again.body.error.code).toBe('INVALID_TOKEN');
      // Garbage looks the same.
      expect((await restore('x'.repeat(43)).expect(400)).body.error.code).toBe('INVALID_TOKEN');
    });

    it('does not restore after the grace period, even before the purge ran', async () => {
      const email = await account('late');
      const token = await deleteAndGetToken(email);
      await db.user.update({
        where: { email },
        data: { deletedAt: new Date(Date.now() - 30 * DAY_MS - 1_000) },
      });
      expect((await restore(token).expect(400)).body.error.code).toBe('INVALID_TOKEN');
      expect((await userOf(email))!.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('purge (identity.account-purge on the worker)', () => {
    it('erases accounts past the grace period with all their rows; keeps the rest; frees the address', async () => {
      const expired = await account('purge-expired');
      const recent = await account('purge-recent');
      const active = await account('purge-active');
      await signIn(expired);
      await deleteAndGetToken(expired);
      await deleteAndGetToken(recent);
      const expiredUser = (await userOf(expired))!;
      await db.user.update({
        where: { email: expired },
        data: { deletedAt: new Date(Date.now() - 31 * DAY_MS) },
      });
      await db.user.update({
        where: { email: recent },
        data: { deletedAt: new Date(Date.now() - 29 * DAY_MS) },
      });

      await app.get(queueApi.QueueProducer).enqueue(identity.ACCOUNT_PURGE_JOB, {});
      await idle('system');
      for (let i = 0; i < 200 && (await userOf(expired)); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(await userOf(expired)).toBeNull();
      const where = { where: { userId: expiredUser.id } };
      expect(await db.userProfile.count(where)).toBe(0);
      expect(await db.userPreference.count(where)).toBe(0);
      expect(await db.userPasswordCredential.count(where)).toBe(0);
      expect(await db.userSession.count(where)).toBe(0);
      expect(await db.userSecurityEvent.count(where)).toBe(0);
      expect(await db.userToken.count(where)).toBe(0);
      expect((await userOf(recent))!.deletedAt).toBeInstanceOf(Date);
      expect((await userOf(active))!.deletedAt).toBeNull();
      expect(lines.join('\n')).toContain('"msg":"account purge"');
      expect(lines.join('\n')).not.toContain(expired);

      // The address can be registered again as a brand-new account.
      await register(expired).expect(202);
      const fresh = (await userOf(expired))!;
      expect(fresh.id).not.toBe(expiredUser.id);
      expect(fresh.deletedAt).toBeNull();
    });

    it('works in batches and never erases an account restored in time', async () => {
      const purge = worker.get(identity.AccountPurgeService);
      const emails = await Promise.all(
        ['b1', 'b2', 'b3', 'b4', 'b5'].map((l) => account(`batch-${l}`)),
      );
      await db.user.updateMany({
        where: { email: { in: emails } },
        data: { deletedAt: new Date(Date.now() - 40 * DAY_MS) },
      });
      // "Restored" just before the purge: not deleted any more.
      await db.user.update({ where: { email: emails[4]! }, data: { deletedAt: null } });
      const erased = await purge.purgeExpired(new Date(), 2);
      expect(erased).toBeGreaterThanOrEqual(4);
      for (const email of emails.slice(0, 4)) expect(await userOf(email)).toBeNull();
      expect(await userOf(emails[4]!)).not.toBeNull();
      // Idempotent.
      expect(await purge.purgeExpired(new Date(), 2)).toBe(0);
    });
  });
});
