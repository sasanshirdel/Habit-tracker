import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type * as IdentityApi from '../src/modules/identity/index.js';

// Integration (backlog P2-08, ADR-0023): session management and security events on real
// PostgreSQL and Redis through the whole API (`createApp` + AppModule: AuthGuard, CSRF, rate
// limiter, validation, error envelope). Rate-limit and queue keys live under this run's prefix.
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'http://localhost:3000'; // CORS_ORIGINS default
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 16; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0';
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
let seq = 0;
const uniqueEmail = (label: string) => `account.${label}.${Date.now()}.${++seq}@example.test`;
let ipSeq = 0;
const freshIp = () => `203.0.113.${(++ipSeq % 250) + 1}`;

interface Signed {
  cookie: string;
  csrf: string;
}

describe('session management and security events (real PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let identity: typeof IdentityApi;
  const lines: string[] = [];
  const http = () => request(app.getHttpServer());

  async function account(label: string): Promise<string> {
    const email = uniqueEmail(label);
    await http()
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', freshIp())
      .set('Origin', ORIGIN)
      .send({ email, password: PASSWORD, locale: 'en', timezone: 'Asia/Tehran' })
      .expect(202);
    return email;
  }
  async function signIn(email: string, userAgent = CHROME_WINDOWS): Promise<Signed> {
    const res = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .set('Origin', ORIGIN)
      .set('User-Agent', userAgent)
      .send({ email, password: PASSWORD })
      .expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    return { cookie, csrf: res.body.csrfToken as string };
  }
  const get = (path: string, who: Signed) =>
    http().get(`/api/v1${path}`).set('Cookie', who.cookie).set('User-Agent', CHROME_WINDOWS);
  const unsafe = (method: 'post' | 'delete', path: string, who: Signed) => {
    const server = http();
    const req = method === 'post' ? server.post(`/api/v1${path}`) : server.delete(`/api/v1${path}`);
    return req
      .set('Cookie', who.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', who.csrf)
      .set('User-Agent', CHROME_WINDOWS);
  };
  const sessions = async (who: Signed) => (await get('/account/sessions', who).expect(200)).body;
  const events = async (who: Signed, query = '') =>
    (await get(`/account/security-events${query}`, who).expect(200)).body;
  const eventTypes = async (who: Signed) =>
    ((await events(who)).data as { type: string }[]).map((e) => e.type);

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.RATE_LIMIT_PREFIX = `${keyPrefix}account`;
    process.env.TRUST_PROXY = '1';
    const { AppModule } = await import('../src/app.module.js');
    const { createApp } = await import('../src/app.factory.js');
    const { JsonLogger } = await import('../src/common/logging/json-logger.js');
    identity = await import('../src/modules/identity/index.js');
    const logger = new JsonLogger({
      service: 'api',
      level: 'trace',
      format: 'json',
      includeErrorMessages: false,
      write: (line) => lines.push(line),
    });
    app = await createApp(AppModule, { logger });
    await app.init();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  }, 60_000);

  beforeEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    delete process.env.TRUST_PROXY;
  });

  it('lists only the caller’s active sessions with a coarse client description, current marked', async () => {
    const email = await account('list');
    const laptop = await signIn(email, CHROME_WINDOWS);
    const phone = await signIn(email, FIREFOX_ANDROID);
    const other = await signIn(await account('list-other'));

    const body = await sessions(laptop);
    expect(body.page).toEqual({ nextCursor: null, hasMore: false, limit: 20 });
    expect(body.data).toHaveLength(2);
    const [newest, oldest] = body.data;
    expect(newest).toMatchObject({
      current: false,
      client: { browser: 'firefox', os: 'android', device: 'mobile' },
    });
    expect(oldest).toMatchObject({
      current: true,
      client: { browser: 'chrome', os: 'windows', device: 'desktop' },
    });
    for (const s of body.data) {
      expect(Object.keys(s).sort()).toEqual([
        'client',
        'createdAt',
        'current',
        'expiresAt',
        'id',
        'lastActiveAt',
      ]);
      expect(Date.parse(s.expiresAt)).toBeGreaterThan(Date.parse(s.createdAt));
    }
    // The other account's session is invisible; the phone sees itself as current.
    const fromPhone = await sessions(phone);
    expect(fromPhone.data.find((s: { current: boolean }) => s.current).id).toBe(newest.id);
    expect((await sessions(other)).data).toHaveLength(1);

    // Stored: three coarse columns, no user agent text anywhere.
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const rows = await db.userSession.findMany({ where: { userId: user.id } });
    expect(rows.map((r) => r.clientBrowser).sort()).toEqual(['chrome', 'firefox']);
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(
      /Mozilla|Gecko|145\.0/,
    );
  });

  it('paginates with an opaque cursor and rejects a forged one', async () => {
    const email = await account('page');
    const first = await signIn(email);
    await signIn(email);
    await signIn(email);
    const page1 = (await get('/account/sessions?limit=2', first).expect(200)).body;
    expect(page1.data).toHaveLength(2);
    expect(page1.page.hasMore).toBe(true);
    const page2 = (
      await get(`/account/sessions?limit=2&cursor=${page1.page.nextCursor}`, first).expect(200)
    ).body;
    expect(page2.data).toHaveLength(1);
    expect(page2.page).toMatchObject({ hasMore: false, nextCursor: null });
    const ids = [...page1.data, ...page2.data].map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(3);
    const bad = await get('/account/sessions?cursor=bm9wZQ', first).expect(400);
    expect(bad.body.error.code).toBe('INVALID_CURSOR');
    expect((await get('/account/sessions?limit=0', first).expect(400)).body.error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('revoking another session ends it immediately; events recorded; cross-user and repeat → 404', async () => {
    const email = await account('revoke');
    const laptop = await signIn(email);
    const phone = await signIn(email, FIREFOX_ANDROID);
    const phoneId = (await sessions(phone)).data.find((s: { current: boolean }) => s.current).id;
    await get('/auth/session', phone).expect(200);

    // Another account cannot touch it (and cannot tell it exists).
    const stranger = await signIn(await account('stranger'));
    const foreign = await unsafe('delete', `/account/sessions/${phoneId}`, stranger).expect(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
    await get('/auth/session', phone).expect(200);

    // CSRF still applies.
    await http()
      .delete(`/api/v1/account/sessions/${phoneId}`)
      .set('Cookie', laptop.cookie)
      .set('Origin', ORIGIN)
      .expect(403);

    await unsafe('delete', `/account/sessions/${phoneId}`, laptop).expect(204);
    // The revoked session is rejected on its very next request.
    expect((await get('/auth/session', phone).expect(401)).body.error.code).toBe('UNAUTHENTICATED');
    await get('/account/sessions', phone).expect(401);
    await get('/auth/session', laptop).expect(200);
    await unsafe('delete', `/account/sessions/${phoneId}`, laptop).expect(404);
    await unsafe('delete', '/account/sessions/not-a-uuid', laptop).expect(400);

    const row = await db.userSession.findUniqueOrThrow({ where: { id: phoneId } });
    expect(row.revokedReason).toBe('revoked_by_user');
    expect(await eventTypes(laptop)).toEqual(['session_revoked', 'sign_in', 'sign_in']);
    expect((await sessions(laptop)).data).toHaveLength(1);
  });

  it('revoking the current session signs out here (cookie cleared, sign_out event)', async () => {
    const email = await account('self');
    const laptop = await signIn(email);
    const other = await signIn(email);
    const selfId = (await sessions(laptop)).data.find((s: { current: boolean }) => s.current).id;
    const res = await unsafe('delete', `/account/sessions/${selfId}`, laptop).expect(204);
    expect(String(res.headers['set-cookie'])).toMatch(/__Host-session=;.*Max-Age=0/);
    await get('/auth/session', laptop).expect(401);
    expect(await eventTypes(other)).toEqual(['sign_out', 'sign_in', 'sign_in']);
  });

  it('sign out all other sessions keeps this one', async () => {
    const email = await account('others');
    const a = await signIn(email);
    const b = await signIn(email, FIREFOX_ANDROID);
    const c = await signIn(email);
    const res = await unsafe('post', '/account/sessions/revoke-others', b).expect(200);
    expect(res.body).toEqual({ revoked: 2 });
    await get('/auth/session', a).expect(401);
    await get('/auth/session', c).expect(401);
    await get('/auth/session', b).expect(200);
    expect((await sessions(b)).data).toHaveLength(1);
    expect((await unsafe('post', '/account/sessions/revoke-others', b).expect(200)).body).toEqual({
      revoked: 0,
    });
    const listed = await events(b);
    expect(listed.data[0]).toMatchObject({
      type: 'signed_out_other_sessions',
      client: { browser: 'chrome', os: 'windows', device: 'desktop' },
    });
  });

  it('records sign-out, sign-out everywhere, email verification and password reset', async () => {
    const email = await account('events');
    const user = await db.user.findUniqueOrThrow({ where: { email } });

    const first = await signIn(email);
    await http()
      .post('/api/v1/auth/logout')
      .set('Cookie', first.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', first.csrf)
      .expect(204);

    // Email verification through the public route with a token issued like the worker does.
    const verification = app.get(identity.EmailVerificationService);
    const { token: verifyToken } = await verification.issue(user.id, email);
    await http()
      .post('/api/v1/auth/verification/confirm')
      .set('X-Forwarded-For', freshIp())
      .set('Origin', ORIGIN)
      .set('User-Agent', FIREFOX_ANDROID)
      .send({ token: verifyToken })
      .expect(200);

    const second = await signIn(email);
    await http()
      .post('/api/v1/auth/logout-everywhere')
      .set('Cookie', second.cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', second.csrf)
      .expect(204);

    const reset = app.get(identity.PasswordResetService);
    const { token: resetToken } = await reset.issue(user.id, email);
    await http()
      .post('/api/v1/auth/password-reset/confirm')
      .set('X-Forwarded-For', freshIp())
      .set('Origin', ORIGIN)
      .set('User-Agent', FIREFOX_ANDROID)
      .send({ token: resetToken, password: PASSWORD })
      .expect(200);

    const third = await signIn(email);
    const listed = await events(third);
    expect(listed.data.map((e: { type: string }) => e.type)).toEqual([
      'sign_in',
      'password_reset',
      'signed_out_everywhere',
      'sign_in',
      'email_verified',
      'sign_out',
      'sign_in',
    ]);
    expect(listed.data[1].client).toEqual({ browser: 'firefox', os: 'android', device: 'mobile' });
    for (const event of listed.data) {
      expect(Object.keys(event).sort()).toEqual(['client', 'id', 'occurredAt', 'type']);
    }
    // Nothing personal in the stored rows or the logs.
    const stored = await db.userSecurityEvent.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(7);
    expect(lines.join('\n')).not.toContain(email);
    expect(lines.join('\n')).not.toMatch(/Mozilla|Gecko/);
  });

  it('retention: expired events are purged on write and never listed; old ended sessions are purged at sign-in', async () => {
    const email = await account('retention');
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await db.userSecurityEvent.create({
      data: { userId: user.id, type: 'sign_in', createdAt: new Date(now - 181 * day) },
    });
    await db.userSecurityEvent.create({
      data: { userId: user.id, type: 'sign_out', createdAt: new Date(now - 179 * day) },
    });
    // An ended session older than 30 days, one ended recently, one long idle.
    const oldHash = (n: number) => new Uint8Array(32).fill(n);
    await db.userSession.create({
      data: {
        userId: user.id,
        tokenHash: oldHash(1),
        createdAt: new Date(now - 60 * day),
        lastUsedAt: new Date(now - 59 * day),
        expiresAt: new Date(now - 30 * day - 60_000),
      },
    });
    await db.userSession.create({
      data: {
        userId: user.id,
        tokenHash: oldHash(2),
        createdAt: new Date(now - 10 * day),
        lastUsedAt: new Date(now - 10 * day),
        expiresAt: new Date(now + 20 * day),
        revokedAt: new Date(now - 5 * day),
        revokedReason: 'sign_out',
      },
    });

    const who = await signIn(email);
    const types = await eventTypes(who);
    expect(types).toEqual(['sign_in', 'sign_out']);
    expect(await db.userSecurityEvent.count({ where: { userId: user.id } })).toBe(2);
    const remaining = await db.userSession.findMany({
      where: { userId: user.id },
      select: { revokedReason: true },
    });
    // The 60-day-old session is gone; the recently signed-out one is kept (not listed).
    expect(remaining.map((r) => r.revokedReason).sort()).toEqual([null, 'sign_out']);
    expect((await sessions(who)).data).toHaveLength(1);
  });

  it('everything needs a session', async () => {
    await http().get('/api/v1/account/sessions').expect(401);
    await http().get('/api/v1/account/security-events').expect(401);
    await http().post('/api/v1/account/sessions/revoke-others').set('Origin', ORIGIN).expect(401);
  });
});
