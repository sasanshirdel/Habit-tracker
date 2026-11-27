import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.factory.js';
import { JsonLogger } from '../src/common/logging/json-logger.js';
import { LOGIN_THROTTLE_STORE, MemoryLoginThrottleStore } from '../src/modules/identity/index.js';
import { MemoryRateLimitStore, RATE_LIMIT_STORE } from '../src/rate-limit/index.js';

// e2e for backlog P2-02 through the real app setup, without PostgreSQL or Redis (unit runs point
// both at a closed port): request validation, the error envelope, rate-limit wiring, cookie
// handling on sign-out, and that rejected input is never echoed or logged. Flows that reach the
// database (register, sign-in, lockout, sessions) are covered on real PostgreSQL/Redis in
// test/auth.int.test.ts.

const SECRET_PASSWORD = 'Sup3r-Secret-Passw0rd!';
const SECRET_EMAIL = 'private.person@example.com';

describe('auth routes (no database)', () => {
  let app: INestApplication;
  const rateLimits = new MemoryRateLimitStore();
  const lines: string[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_STORE)
      .useValue(rateLimits)
      .overrideProvider(LOGIN_THROTTLE_STORE)
      .useValue(new MemoryLoginThrottleStore())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: new JsonLogger({
        service: 'api',
        level: 'trace',
        format: 'json',
        includeErrorMessages: false,
        write: (line) => lines.push(line),
      }),
    });
    configureApp(app as NestExpressApplication);
    await app.init();
  }, 30_000);

  beforeEach(() => {
    rateLimits.reset();
    lines.length = 0;
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    [
      'unknown field',
      {
        email: SECRET_EMAIL,
        password: SECRET_PASSWORD,
        locale: 'en',
        timezone: 'UTC',
        role: 'admin',
      },
      'body.role',
    ],
    [
      'short password',
      { email: SECRET_EMAIL, password: 'short', locale: 'en', timezone: 'UTC' },
      'body.password',
    ],
    [
      'invalid email',
      { email: 'not-an-email', password: SECRET_PASSWORD, locale: 'en', timezone: 'UTC' },
      'body.email',
    ],
    [
      'missing locale',
      { email: SECRET_EMAIL, password: SECRET_PASSWORD, timezone: 'UTC' },
      'body.locale',
    ],
  ])('register: %s → 400 VALIDATION_FAILED without echoing input', async (_name, body, field) => {
    const res = await http().post('/api/v1/auth/register').send(body).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.issues.map((i: { field: string }) => i.field)).toContain(field);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET_PASSWORD);
    expect(text).not.toContain(SECRET_EMAIL);
    expect(text).not.toContain('short');
  });

  it('register: password policy errors carry zod size codes for localisation', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .send({
        email: SECRET_EMAIL,
        password: 'x'.repeat(129),
        locale: 'fa',
        timezone: 'Asia/Tehran',
      })
      .expect(400);
    expect(res.body.error.details.issues).toEqual([
      { field: 'body.password', code: 'too_big', message: expect.any(String) },
    ]);
  });

  it('login: rejects non-JSON bodies (no form posts, so no cross-site form login)', async () => {
    const res = await http()
      .post('/api/v1/auth/login')
      .type('form')
      .send(`email=${encodeURIComponent(SECRET_EMAIL)}&password=${SECRET_PASSWORD}`)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('login and register count against the auth class (10 per 5 min per address)', async () => {
    for (let i = 0; i < 10; i++) {
      await http().post('/api/v1/auth/login').send({}).expect(400);
    }
    const res = await http().post('/api/v1/auth/login').send({}).expect(429);
    expect(res.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { policy: 'auth' } });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // register shares the class and the address's budget.
    await http().post('/api/v1/auth/register').send({}).expect(429);
  });

  it('logout without a session: 204 and the cookie is cleared', async () => {
    const res = await http().post('/api/v1/auth/logout').expect(204);
    expect(res.headers['set-cookie']).toEqual([
      '__Host-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('logout with a malformed cookie: 204, nothing looked up', async () => {
    await http().post('/api/v1/auth/logout').set('Cookie', '__Host-session=garbage').expect(204);
  });

  it('logout-everywhere without a session: 401 UNAUTHENTICATED (guard); a dead cookie is cleared', async () => {
    const none = await http().post('/api/v1/auth/logout-everywhere').expect(401);
    expect(none.body.error.code).toBe('UNAUTHENTICATED');
    expect(none.headers['set-cookie']).toBeUndefined();
    const dead = await http()
      .post('/api/v1/auth/logout-everywhere')
      .set('Cookie', '__Host-session=garbage')
      .expect(401);
    expect(dead.body.error.code).toBe('UNAUTHENTICATED');
    expect(dead.headers['set-cookie']?.[0]).toMatch(/^__Host-session=; Path=\/; Max-Age=0;/);
  });

  it('never logs submitted credentials', async () => {
    await http()
      .post('/api/v1/auth/register')
      .send({ email: SECRET_EMAIL, password: 'short', locale: 'en', timezone: 'UTC' })
      .expect(400);
    await http().post('/api/v1/auth/login').send({ email: SECRET_EMAIL, password: '' }).expect(400);
    await new Promise((r) => setTimeout(r, 20));
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0); // access lines were written
    expect(text).not.toContain(SECRET_EMAIL);
    expect(text).not.toContain('short');
  });
  describe('email verification (P2-04)', () => {
    const GARBAGE_TOKEN = 'not-a-real-token-but-secret-looking-value';

    it('confirm: a malformed token is the same 400 INVALID_TOKEN as any other, never echoed or logged', async () => {
      const res = await http()
        .post('/api/v1/auth/verification/confirm')
        .send({ token: GARBAGE_TOKEN })
        .expect(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_TOKEN' });
      expect(JSON.stringify(res.body)).not.toContain(GARBAGE_TOKEN);
      await new Promise((r) => setTimeout(r, 20));
      expect(lines.join('\n')).not.toContain(GARBAGE_TOKEN);
    });

    it('confirm: validates the body (strict, bounded)', async () => {
      for (const body of [
        {},
        { token: '' },
        { token: 'x'.repeat(129) },
        { token: 'a', extra: 1 },
      ]) {
        const res = await http().post('/api/v1/auth/verification/confirm').send(body).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('confirm: public but origin-checked; counts against the auth class', async () => {
      const foreign = await http()
        .post('/api/v1/auth/verification/confirm')
        .set('Origin', 'https://attacker.example')
        .send({ token: GARBAGE_TOKEN })
        .expect(403);
      expect(foreign.body.error.code).toBe('CSRF_FAILED');
      for (let i = 0; i < 10; i++) {
        await http().post('/api/v1/auth/verification/confirm').send({ token: 'x' });
      }
      const limited = await http()
        .post('/api/v1/auth/verification/confirm')
        .send({ token: 'x' })
        .expect(429);
      expect(limited.body.error.details.policy).toBe('auth');
    });

    it('resend: signed-in only (401 without a session)', async () => {
      const res = await http().post('/api/v1/auth/verification/resend').expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });
});
