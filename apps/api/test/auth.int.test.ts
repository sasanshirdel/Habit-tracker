import 'reflect-metadata';
import { argon2Sync, createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { RespClient } from './integration/redis-resp.js';

// Integration (backlog P2-02): registration, sign-in, lockout, rate limiting and sign-out through
// the real app (`createApp` + AppModule) on a real PostgreSQL (migrated by global setup) and Redis
// (keys under this run's prefix, deleted by global teardown).
//
// TRUST_PROXY=1 lets each scenario present its own client address in X-Forwarded-For, so the
// per-address `auth` class (10 per 5 min) is exercised on purpose instead of throttling the whole
// file; the per-email lockout uses distinct addresses per scenario.
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');

const PASSWORD = 'correct horse battery staple';
const PHC = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

let seq = 0;
const uniqueEmail = (label: string) => `${label}.${Date.now()}.${++seq}@example.test`;
let ipSeq = 0;
/** A fresh client address (TEST-NET-2) for one scenario. */
const freshIp = () => `198.51.100.${++ipSeq}`;

async function scanKeys(redis: RespClient, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const reply = (await redis.command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500'])) as [
      string,
      string[],
    ];
    cursor = String(reply[0]);
    keys.push(...reply[1].map(String));
  } while (cursor !== '0');
  return keys;
}

function sessionTokenFrom(setCookie: string[] | string | undefined): string {
  const header = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])[0] ?? '';
  const match = /^__Host-session=([A-Za-z0-9_-]{43});/.exec(header);
  if (!match) throw new Error('no session cookie in response');
  return match[1]!;
}

const sha256 = (token: string) => new Uint8Array(createHash('sha256').update(token).digest());

describe('email/password authentication (real PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let redis: RespClient;
  const lines: string[] = [];
  const http = () => request(app.getHttpServer());
  const post = (path: string, ip: string) =>
    http().post(`/api/v1/auth/${path}`).set('X-Forwarded-For', ip);

  function register(email: string, ip = freshIp(), password = PASSWORD) {
    return post('register', ip).send({ email, password, locale: 'fa', timezone: 'Asia/Tehran' });
  }

  function login(email: string, password: string, ip = freshIp(), cookie?: string) {
    const req = post('login', ip).send({ email, password });
    if (cookie) req.set('Cookie', `__Host-session=${cookie}`);
    return req;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.RATE_LIMIT_PREFIX = `${keyPrefix}auth`;
    process.env.TRUST_PROXY = '1';
    const { AppModule } = await import('../src/app.module.js');
    const { createApp } = await import('../src/app.factory.js');
    const { JsonLogger } = await import('../src/common/logging/json-logger.js');
    app = await createApp(AppModule, {
      logger: new JsonLogger({
        service: 'api',
        level: 'trace',
        format: 'json',
        includeErrorMessages: false,
        write: (line) => lines.push(line),
      }),
    });
    await app.init();
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
    await app?.close();
    await db?.$disconnect();
    await redis?.quit();
    delete process.env.TRUST_PROXY;
  });

  describe('registration', () => {
    it('creates the account, profile, preferences and an Argon2id credential; no session', async () => {
      const email = uniqueEmail('register.new');
      const res = await post('register', freshIp())
        .send({
          email: `  ${email.toUpperCase()} `,
          password: PASSWORD,
          locale: 'fa',
          timezone: 'Asia/Tehran',
          displayName: ' سارا ',
        })
        .expect(202);
      expect(res.body).toEqual({ status: 'accepted' });
      expect(res.headers['set-cookie']).toBeUndefined();

      const user = await db.user.findUniqueOrThrow({
        where: { email: email.toLowerCase() },
        include: { profile: true, preference: true, passwordCredential: true, sessions: true },
      });
      expect(user.email).toBe(email.toLowerCase());
      expect(user.emailVerifiedAt).toBeNull();
      expect(user.profile?.displayName).toBe('سارا');
      expect(user.preference).toMatchObject({
        locale: 'fa',
        timezone: 'Asia/Tehran',
        theme: 'dark',
      });
      expect(user.passwordCredential?.passwordHash).toMatch(PHC);
      expect(user.passwordCredential?.passwordHash).not.toContain(PASSWORD);
      expect(user.sessions).toEqual([]);
    });

    it('answers a taken address identically and leaves the account untouched', async () => {
      const email = uniqueEmail('taken');
      const first = await register(email).expect(202);
      const before = await db.userPasswordCredential.findFirstOrThrow({
        where: { user: { email } },
      });
      const second = await register(email.toUpperCase(), freshIp(), 'a different password').expect(
        202,
      );
      expect(second.body).toEqual(first.body);
      expect(Object.keys(second.headers).sort()).toEqual(Object.keys(first.headers).sort());
      expect(await db.user.count({ where: { email } })).toBe(1);
      const after = await db.userPasswordCredential.findFirstOrThrow({
        where: { user: { email } },
      });
      expect(after.passwordHash).toBe(before.passwordHash);
      // The original password still works; the second one does not.
      await login(email, PASSWORD).expect(200);
      await login(email, 'a different password').expect(401);
    });

    it("answers a soft-deleted account's address identically (address stays reserved)", async () => {
      const email = uniqueEmail('deleted');
      await register(email).expect(202);
      await db.user.update({ where: { email }, data: { deletedAt: new Date() } });
      const res = await register(email).expect(202);
      expect(res.body).toEqual({ status: 'accepted' });
      expect(await db.user.count({ where: { email } })).toBe(1);
      // A deleted account cannot sign in, even with the right password — same 401 as a stranger.
      const denied = await login(email, PASSWORD).expect(401);
      expect(denied.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('sign-in', () => {
    it('signs in, sets a __Host- session cookie and stores only the token hash', async () => {
      const email = uniqueEmail('signin');
      await register(email).expect(202);
      const res = await login(email.toUpperCase(), PASSWORD).expect(200);
      const user = await db.user.findUniqueOrThrow({ where: { email } });
      expect(res.body).toEqual({ user: { id: user.id, email, emailVerified: false } });

      const setCookie = res.headers['set-cookie'] as unknown as string[];
      expect(setCookie).toHaveLength(1);
      expect(setCookie[0]).toMatch(
        /^__Host-session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/,
      );
      const token = sessionTokenFrom(setCookie);
      expect(JSON.stringify(res.body)).not.toContain(token);
      expect(res.headers['cache-control']).toBe('no-store');

      const sessions = await db.userSession.findMany({ where: { userId: user.id } });
      expect(sessions).toHaveLength(1);
      expect(Buffer.from(sessions[0]!.tokenHash).equals(Buffer.from(sha256(token)))).toBe(true);
      expect(sessions[0]!.revokedAt).toBeNull();
      const lifetime = sessions[0]!.expiresAt.getTime() - sessions[0]!.createdAt.getTime();
      expect(lifetime).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('gives an unknown address and a wrong password the same 401', async () => {
      const email = uniqueEmail('enum');
      await register(email).expect(202);
      const wrong = await login(email, 'not the password').expect(401);
      const unknown = await login(uniqueEmail('nobody'), 'not the password').expect(401);
      const strip = (body: { error: Record<string, unknown> }) => ({
        ...body.error,
        requestId: 'x',
      });
      expect(strip(wrong.body)).toEqual(strip(unknown.body));
      expect(wrong.body.error).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
        requestId: expect.any(String),
      });
      for (const res of [wrong, unknown]) expect(res.headers['set-cookie']).toBeUndefined();
      expect(Object.keys(wrong.headers).sort()).toEqual(Object.keys(unknown.headers).sort());
    });

    it('takes comparable time for an unknown address and a wrong password (dummy hash)', async () => {
      const email = uniqueEmail('timing');
      await register(email).expect(202);
      const time = async (address: string) => {
        const start = process.hrtime.bigint();
        await login(address, 'not the password').expect(401);
        return Number(process.hrtime.bigint() - start) / 1e6;
      };
      // Different addresses per sample keep the per-address lockout out of the measurement.
      const known: number[] = [];
      const unknown: number[] = [];
      for (let i = 0; i < 4; i++) {
        known.push(await time(email));
        unknown.push(await time(uniqueEmail('timing-unknown')));
      }
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      const ratio = median(unknown) / median(known);
      // Both paths run one Argon2id verification (tens of ms); without the dummy hash an unknown
      // address would answer in a few ms (ratio ≪ 0.5). Bounds are loose for noisy CI runners.
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2);
    });

    it('rotates the session presented at sign-in (fixation) and keeps other sessions', async () => {
      const email = uniqueEmail('rotate');
      await register(email).expect(202);
      const first = sessionTokenFrom(
        (await login(email, PASSWORD).expect(200)).headers['set-cookie'],
      );
      const other = sessionTokenFrom(
        (await login(email, PASSWORD).expect(200)).headers['set-cookie'],
      );
      const second = sessionTokenFrom(
        (await login(email, PASSWORD, freshIp(), first).expect(200)).headers['set-cookie'],
      );
      expect(second).not.toBe(first);
      const byToken = async (t: string) =>
        db.userSession.findUniqueOrThrow({ where: { tokenHash: sha256(t) } });
      expect(await byToken(first)).toMatchObject({ revokedReason: 'rotated' });
      expect((await byToken(first)).revokedAt).not.toBeNull();
      expect((await byToken(other)).revokedAt).toBeNull();
      expect((await byToken(second)).revokedAt).toBeNull();
    });

    it('upgrades a hash made with older parameters at sign-in', async () => {
      const email = uniqueEmail('rehash');
      await register(email).expect(202);
      const salt = Buffer.alloc(16, 9);
      const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
      const old = `$argon2id$v=19$m=9216,t=4,p=1$${b64(salt)}$${b64(
        argon2Sync('argon2id', {
          message: PASSWORD,
          nonce: salt,
          memory: 9216,
          passes: 4,
          parallelism: 1,
          tagLength: 32,
        }),
      )}`;
      await db.userPasswordCredential.updateMany({
        where: { user: { email } },
        data: { passwordHash: old },
      });
      await login(email, PASSWORD).expect(200);
      const after = await db.userPasswordCredential.findFirstOrThrow({
        where: { user: { email } },
      });
      expect(after.passwordHash).toMatch(PHC);
      await login(email, PASSWORD).expect(200);
    });
  });

  describe('brute-force protection', () => {
    it('locks an address after 5 failures, even for the right password, with Retry-After', async () => {
      const email = uniqueEmail('lockout');
      await register(email).expect(202);
      const ip = freshIp();
      for (let i = 0; i < 5; i++) await login(email, `wrong ${i}`, ip).expect(401);
      const locked = await login(email, PASSWORD, freshIp()).expect(429);
      expect(locked.body.error).toMatchObject({
        code: 'RATE_LIMITED',
        details: { policy: 'login-account', retryAfterSeconds: expect.any(Number) },
      });
      const retryAfter = Number(locked.headers['retry-after']);
      expect(retryAfter).toBe(locked.body.error.details.retryAfterSeconds);
      expect(retryAfter).toBeGreaterThan(50);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(locked.headers['set-cookie']).toBeUndefined();
      // Other addresses are not affected.
      const other = uniqueEmail('lockout-other');
      await register(other).expect(202);
      await login(other, PASSWORD).expect(200);
    });

    it('locks an unknown address exactly like a registered one (no enumeration)', async () => {
      const email = uniqueEmail('lockout-unknown');
      const ip = freshIp();
      for (let i = 0; i < 5; i++) await login(email, `wrong ${i}`, ip).expect(401);
      const locked = await login(email, 'anything', freshIp()).expect(429);
      expect(locked.body.error.details.policy).toBe('login-account');
    });

    it('resets the count after a successful sign-in', async () => {
      const email = uniqueEmail('lockout-reset');
      await register(email).expect(202);
      const ip = freshIp();
      for (let i = 0; i < 4; i++) await login(email, `wrong ${i}`, ip).expect(401);
      await login(email, PASSWORD, ip).expect(200);
      const ip2 = freshIp();
      for (let i = 0; i < 4; i++) await login(email, `wrong ${i}`, ip2).expect(401);
      await login(email, PASSWORD, ip2).expect(200);
    });

    it('limits one client address to 10 auth requests per 5 minutes across addresses', async () => {
      const ip = freshIp();
      for (let i = 0; i < 10; i++) await login(uniqueEmail('spray'), 'whatever', ip).expect(401);
      const res = await login(uniqueEmail('spray'), 'whatever', ip).expect(429);
      expect(res.body.error.details.policy).toBe('auth');
      await register(uniqueEmail('spray'), ip).expect(429);
    });

    it('keeps lockout counters hashed, under the configured prefix, with a TTL', async () => {
      const keys = await scanKeys(redis, `${keyPrefix}auth:login-account:*`);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key).toMatch(
          new RegExp(`^${keyPrefix}auth:login-account:(fail|lock):[0-9a-f]{32}$`),
        );
        expect(key).not.toContain('@');
        expect(Number(await redis.command(['PTTL', key]))).toBeGreaterThan(0);
      }
    });
  });

  describe('sign-out', () => {
    it('revokes the current session, clears the cookie and is idempotent', async () => {
      const email = uniqueEmail('logout');
      await register(email).expect(202);
      const token = sessionTokenFrom(
        (await login(email, PASSWORD).expect(200)).headers['set-cookie'],
      );
      const res = await http()
        .post('/api/v1/auth/logout')
        .set('Cookie', `__Host-session=${token}`)
        .expect(204);
      expect(res.headers['set-cookie']).toEqual([
        '__Host-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      ]);
      const session = await db.userSession.findUniqueOrThrow({
        where: { tokenHash: sha256(token) },
      });
      expect(session.revokedReason).toBe('sign_out');
      await http().post('/api/v1/auth/logout').set('Cookie', `__Host-session=${token}`).expect(204);
      // A revoked session no longer authenticates.
      await http()
        .post('/api/v1/auth/logout-everywhere')
        .set('Cookie', `__Host-session=${token}`)
        .expect(401);
    });

    it('signs out everywhere: every session of that user only', async () => {
      const email = uniqueEmail('everywhere');
      const bystander = uniqueEmail('bystander');
      await register(email).expect(202);
      await register(bystander).expect(202);
      const a = sessionTokenFrom((await login(email, PASSWORD).expect(200)).headers['set-cookie']);
      const b = sessionTokenFrom((await login(email, PASSWORD).expect(200)).headers['set-cookie']);
      const c = sessionTokenFrom(
        (await login(bystander, PASSWORD).expect(200)).headers['set-cookie'],
      );
      const res = await http()
        .post('/api/v1/auth/logout-everywhere')
        .set('Cookie', `__Host-session=${a}`)
        .expect(204);
      expect(res.headers['set-cookie']?.[0]).toMatch(/^__Host-session=; Path=\/; Max-Age=0;/);
      for (const t of [a, b]) {
        const s = await db.userSession.findUniqueOrThrow({ where: { tokenHash: sha256(t) } });
        expect(s.revokedReason).toBe('sign_out_everywhere');
      }
      const untouched = await db.userSession.findUniqueOrThrow({ where: { tokenHash: sha256(c) } });
      expect(untouched.revokedAt).toBeNull();
    });

    it('treats expired and idle sessions as signed out', async () => {
      const email = uniqueEmail('expired');
      await register(email).expect(202);
      const expired = sessionTokenFrom(
        (await login(email, PASSWORD).expect(200)).headers['set-cookie'],
      );
      const idle = sessionTokenFrom(
        (await login(email, PASSWORD).expect(200)).headers['set-cookie'],
      );
      const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await db.userSession.update({
        where: { tokenHash: sha256(expired) },
        data: { createdAt: longAgo, expiresAt: new Date(Date.now() - 1000) },
      });
      await db.userSession.update({
        where: { tokenHash: sha256(idle) },
        data: { lastUsedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
      });
      for (const t of [expired, idle]) {
        await http()
          .post('/api/v1/auth/logout-everywhere')
          .set('Cookie', `__Host-session=${t}`)
          .expect(401);
      }
    });
  });

  it('never logs passwords, email addresses, session tokens or hashes', async () => {
    const email = uniqueEmail('logcheck');
    await register(email).expect(202);
    await login(email, 'wrong password here').expect(401);
    const res = await login(email, PASSWORD).expect(200);
    const token = sessionTokenFrom(res.headers['set-cookie']);
    await http().post('/api/v1/auth/logout').set('Cookie', `__Host-session=${token}`).expect(204);
    await new Promise((r) => setTimeout(r, 50));
    const credential = await db.userPasswordCredential.findFirstOrThrow({
      where: { user: { email } },
    });
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [
      PASSWORD,
      'wrong password here',
      email,
      token,
      credential.passwordHash,
      credential.passwordHash.split('$').at(-1)!,
    ]) {
      expect(text).not.toContain(secret);
    }
    // The successful sign-in's access line carries the user id (not the address).
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(text).toContain(user.id);
  });
});
