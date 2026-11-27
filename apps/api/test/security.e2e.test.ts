import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Controller,
  Get,
  Module,
  Post,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.factory.js';
import { setRequestUserId } from '../src/common/index.js';
import { API_SECURITY_HEADERS } from '../src/common/security/security-headers.js';
import {
  MemoryRateLimitStore,
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_STORE,
  RateLimit,
  RateLimitStoreUnavailableError,
  type RateLimitStore,
} from '../src/rate-limit/index.js';
import { Public } from '../src/common/auth/index.js';

// e2e for backlog P1-08 through the real global setup (`configureApp` + AppModule): security
// headers, CORS allow-list and the rate-limit guard. The Redis store is replaced by an in-memory
// one (no Redis in unit runs — see vitest.config.ts); the Redis path is covered by
// test/rate-limit.int.test.ts. Test-only routes; nothing here ships.

const ALLOWED_ORIGIN = 'http://localhost:3000'; // CORS_ORIGINS default

// Test-only routes: public, so these suites exercise conventions without a session (P2-03).
@Public()
@Controller('security-test')
class SecurityTestController {
  @Get('open')
  open() {
    return { ok: true };
  }

  @RateLimit({
    name: 'test-tight',
    limit: 3,
    windowSeconds: 60,
    key: 'ip',
    onStoreFailure: 'allow',
  })
  @Get('tight')
  tight() {
    return { ok: true };
  }

  @RateLimit('auth')
  @Post('login')
  login() {
    return { ok: true };
  }
}

/** Stands in for the P2-03 auth guard: `x-test-user` marks the request as that user. */
function fakeAuth(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
  const user = req.headers['x-test-user'];
  if (typeof user === 'string') setRequestUserId(user);
  next();
}

@Module({ imports: [AppModule], controllers: [SecurityTestController] })
class SecurityTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(fakeAuth).forRoutes('*path');
  }
}

/** A store whose availability the test controls. */
class SwitchableStore implements RateLimitStore {
  readonly memory = new MemoryRateLimitStore();
  down = false;

  async hit(key: string, windowMs: number) {
    if (this.down) throw new RateLimitStoreUnavailableError('not_connected');
    return this.memory.hit(key, windowMs);
  }
}

describe('security headers, CORS and rate limiting (P1-08)', () => {
  let app: INestApplication;
  const store = new SwitchableStore();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SecurityTestModule] })
      .overrideProvider(RATE_LIMIT_STORE)
      .useValue(store)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    store.memory.reset();
    store.down = false;
  });

  describe('security headers', () => {
    const expectSecurityHeaders = (headers: Record<string, string>) => {
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
        expect(headers[name.toLowerCase()], name).toBe(value);
      }
      expect(headers['x-powered-by']).toBeUndefined();
    };

    it('are set on successful responses', async () => {
      const res = await http().get('/api/v1/security-test/open').expect(200);
      expectSecurityHeaders(res.headers);
    });

    it('are set on 404s, malformed bodies and health probes', async () => {
      expectSecurityHeaders((await http().get('/api/v1/nope').expect(404)).headers);
      const bad = await http()
        .post('/api/v1/security-test/login')
        .set('content-type', 'application/json')
        .send('{"broken"')
        .expect(400);
      expect(bad.body.error.code).toBe('MALFORMED_REQUEST_BODY');
      expectSecurityHeaders(bad.headers);
      expectSecurityHeaders((await http().get('/api/v1/health')).headers);
    });

    it('are set on 429s', async () => {
      for (let i = 0; i < 3; i++) await http().get('/api/v1/security-test/tight').expect(200);
      expectSecurityHeaders((await http().get('/api/v1/security-test/tight').expect(429)).headers);
    });
  });

  describe('CORS', () => {
    it('answers an allowed origin with credentials and exposed headers', async () => {
      const res = await http()
        .get('/api/v1/security-test/open')
        .set('Origin', ALLOWED_ORIGIN)
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-expose-headers']).toBe(
        'x-request-id,Retry-After,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset',
      );
      expect(res.headers.vary).toMatch(/Origin/);
    });

    it('gives a foreign origin no CORS headers (the browser blocks the response)', async () => {
      const res = await http()
        .get('/api/v1/security-test/open')
        .set('Origin', 'https://evil.example')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('answers preflights with the explicit method and header lists', async () => {
      const res = await http()
        .options('/api/v1/security-test/login')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-evil')
        .expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,POST,PUT,PATCH,DELETE');
      // Not a reflection of what was requested.
      expect(res.headers['access-control-allow-headers']).toBe(
        'Accept,Accept-Language,Content-Type,X-Request-Id,X-CSRF-Token',
      );
      expect(res.headers['access-control-max-age']).toBe('600');
    });

    it('does not answer preflights from foreign origins', async () => {
      const res = await http()
        .options('/api/v1/security-test/login')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-methods']).toBeUndefined();
    });
  });

  describe('rate limiting', () => {
    it('sends RateLimit-* headers on limited routes', async () => {
      const res = await http().get('/api/v1/security-test/open').expect(200);
      expect(res.headers['ratelimit-limit']).toBe('300');
      expect(res.headers['ratelimit-remaining']).toBe('299');
      expect(Number(res.headers['ratelimit-reset'])).toBeGreaterThan(0);
      expect(Number(res.headers['ratelimit-reset'])).toBeLessThanOrEqual(60);
    });

    it('returns 429 RATE_LIMITED with Retry-After in the standard envelope', async () => {
      for (let i = 1; i <= 3; i++) {
        const ok = await http().get('/api/v1/security-test/tight').expect(200);
        expect(ok.headers['ratelimit-remaining']).toBe(String(3 - i));
      }
      const res = await http().get('/api/v1/security-test/tight').expect(429);
      const retryAfter = Number(res.headers['retry-after']);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(res.headers['ratelimit-limit']).toBe('3');
      expect(res.headers['ratelimit-remaining']).toBe('0');
      expect(res.body).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests.',
          details: { retryAfterSeconds: retryAfter, policy: 'test-tight' },
          requestId: res.headers['x-request-id'],
        },
      });
    });

    it('applies the global default limit to every routed request', async () => {
      const { limit } = RATE_LIMIT_CLASSES.default;
      for (let i = 0; i < limit; i++) await http().get('/api/v1/security-test/open').expect(200);
      const res = await http().get('/api/v1/security-test/open').expect(429);
      expect(res.body.error.details.policy).toBe('default');
      // The default budget is shared across routes: a different route is limited too.
      await http().get('/api/v1/security-test/tight').expect(429);
    });

    it('applies the auth class per address on top of the default', async () => {
      const { limit } = RATE_LIMIT_CLASSES.auth;
      for (let i = 0; i < limit; i++) await http().post('/api/v1/security-test/login').expect(201);
      const res = await http().post('/api/v1/security-test/login').expect(429);
      expect(res.body.error.details.policy).toBe('auth');
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(300);
      // Being signed in does not buy a pre-auth route a new budget.
      await http().post('/api/v1/security-test/login').set('x-test-user', 'u1').expect(429);
      // Other routes still work (default budget not exhausted).
      await http().get('/api/v1/security-test/open').expect(200);
    });

    it('gives authenticated users their own budget on user-or-ip classes', async () => {
      const { limit } = RATE_LIMIT_CLASSES.default;
      for (let i = 0; i < limit; i++) {
        await http().get('/api/v1/security-test/open').set('x-test-user', 'u1').expect(200);
      }
      await http().get('/api/v1/security-test/open').set('x-test-user', 'u1').expect(429);
      // Same address, different user: separate budget.
      await http().get('/api/v1/security-test/open').set('x-test-user', 'u2').expect(200);
      await http().get('/api/v1/security-test/open').expect(200);
    });

    it('ignores X-Forwarded-For unless TRUST_PROXY is set (no budget reset by spoofing)', async () => {
      for (let i = 0; i < 3; i++) await http().get('/api/v1/security-test/tight').expect(200);
      await http()
        .get('/api/v1/security-test/tight')
        .set('X-Forwarded-For', '203.0.113.99')
        .expect(429);
    });

    it('never limits health probes', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await http().get('/api/v1/health').expect(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
      }
    });

    it('does not count unmatched routes or preflights', async () => {
      await http().get('/api/v1/nope').expect(404);
      await http()
        .options('/api/v1/security-test/open')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'GET')
        .expect(204);
      const res = await http().get('/api/v1/security-test/open').expect(200);
      expect(res.headers['ratelimit-remaining']).toBe('299');
    });

    it('fails open for the default class and closed for auth when the store is down', async () => {
      store.down = true;
      const open = await http().get('/api/v1/security-test/open').expect(200);
      expect(open.headers['ratelimit-limit']).toBeUndefined();
      const login = await http().post('/api/v1/security-test/login').expect(503);
      expect(login.body.error).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable.',
      });
      expect(JSON.stringify(login.body)).not.toMatch(/not_connected|Redis|store/i);
    });
  });
});
