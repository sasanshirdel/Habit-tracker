import 'reflect-metadata';
import {
  Controller,
  Delete,
  Get,
  Module,
  Patch,
  Post,
  Put,
  RequestMethod,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.factory.js';
import {
  CurrentUser,
  Public,
  RequireVerifiedEmail,
  routeAuthPolicy,
  type RequestPrincipal,
  type RouteAuthPolicy,
} from '../src/common/auth/index.js';
import {
  LOGIN_THROTTLE_STORE,
  MemoryLoginThrottleStore,
  SessionService,
  csrfTokenFor,
  type ActiveSession,
} from '../src/modules/identity/index.js';
import { MemoryRateLimitStore, RATE_LIMIT_STORE } from '../src/rate-limit/index.js';

// Backlog P2-03 (ADR-0019): deny by default.
// 1. Route inventory: every route the app registers is either protected by the global AuthGuard
//    (and really answers 401 without a session) or explicitly marked public and listed below.
//    Adding a public route — or forgetting the guard — fails this file.
// 2. Authorization matrix scaffold: session state × origin × CSRF token × method → status, on
//    test routes, with SessionService stubbed (the real session rules run on PostgreSQL in
//    test/auth.int.test.ts).

/**
 * The reviewed list of routes reachable without a session. Change it only together with a
 * security review of the route (ADR-0019). The OpenAPI document (`/api/docs/openapi.json`) is a
 * plain Express handler outside Nest's router, off in production (ADR-0012), and not listed.
 */
const PUBLIC_ROUTES: Record<string, Exclude<RouteAuthPolicy, 'required'>> = {
  'GET /health': 'public',
  'GET /health/ready': 'public',
  'POST /auth/register': 'public',
  'POST /auth/login': 'public',
  'POST /auth/logout': 'optional',
  // P2-04 (ADR-0021): the emailed link's token is the credential; origin-checked, `auth` class.
  'POST /auth/verification/confirm': 'public',
  // P2-05 (ADR-0022): anyone can ask for a reset link (identical 202 for every address, per-address
  // limit) and the emailed token is the credential of the reset; origin-checked, `auth` class.
  'POST /auth/password-reset/request': 'public',
  'POST /auth/password-reset/confirm': 'public',
  // P2-10 (ADR-0025): a deleted account has no session; the emailed restore token is the
  // credential; origin-checked, `auth` class.
  'POST /auth/account-restore': 'public',
};

const METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.ALL]: 'ALL',
};

interface RouteInfo {
  key: string;
  method: string;
  path: string;
  policy: RouteAuthPolicy;
}

/** Every routed handler of every controller in the app, with its auth policy. */
function listRoutes(app: INestApplication): RouteInfo[] {
  const reflector = new Reflector();
  const scanner = new MetadataScanner();
  const routes: RouteInfo[] = [];
  const controllers = new Set<Type<unknown>>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      if (typeof wrapper.metatype === 'function')
        controllers.add(wrapper.metatype as Type<unknown>);
    }
  }
  for (const controller of controllers) {
    const prefixes = [Reflect.getMetadata(PATH_METADATA, controller) as string | string[]].flat();
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name] as (...args: never[]) => unknown;
      const paths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (paths === undefined) continue;
      const method = METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      for (const prefix of prefixes) {
        for (const p of [paths].flat()) {
          const path = `/${[prefix, p]
            .flatMap((x) => (x ?? '').split('/'))
            .filter(Boolean)
            .join('/')}`;
          routes.push({
            key: `${method ?? '?'} ${path}`,
            method: method ?? '?',
            path,
            policy: routeAuthPolicy(reflector, handler, controller),
          });
        }
      }
    }
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}

const rateLimits = new MemoryRateLimitStore();

async function bootstrap(rootModule: Type<unknown>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [rootModule] })
    .overrideProvider(RATE_LIMIT_STORE)
    .useValue(rateLimits)
    .overrideProvider(LOGIN_THROTTLE_STORE)
    .useValue(new MemoryLoginThrottleStore())
    .overrideProvider(SessionService)
    .useValue(sessionStub)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app as NestExpressApplication);
  await app.init();
  return app;
}

// --- Session stub: tokens are looked up in a map; everything else is "unknown". -------------
const LIVE = 'live-session-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'other-session-token-bbbbbbbbbbbbbbbbbbbbbbbbbbb';
const sessionsByToken = new Map<string, ActiveSession>([
  [
    LIVE,
    { sessionId: 's-live', userId: '0190a000-0000-7000-8000-000000000001', emailVerified: true },
  ],
  [
    OTHER,
    { sessionId: 's-other', userId: '0190a000-0000-7000-8000-000000000002', emailVerified: false },
  ],
]);
let lookups = 0;
const sessionStub = {
  resolve: (token: unknown) => {
    lookups++;
    return Promise.resolve(typeof token === 'string' ? (sessionsByToken.get(token) ?? null) : null);
  },
  revokeToken: () => Promise.resolve(false),
  revokeAllForUser: () => Promise.resolve(0),
  create: () => Promise.reject(new Error('not in this test')),
};

describe('route inventory: deny by default (AppModule)', () => {
  let app: INestApplication;
  let routes: RouteInfo[];

  beforeAll(async () => {
    app = await bootstrap(AppModule);
    routes = listRoutes(app);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('finds the routes (sanity check of the enumeration itself)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(7);
    expect(routes.map((r) => r.key)).toContain('GET /auth/session');
    expect(routes.every((r) => r.method !== '?')).toBe(true);
  });

  it('marks exactly the reviewed routes as public', () => {
    const marked = Object.fromEntries(
      routes.filter((r) => r.policy !== 'required').map((r) => [r.key, r.policy]),
    );
    expect(marked).toEqual(PUBLIC_ROUTES);
  });

  it('answers 401 UNAUTHENTICATED on every other route without a session', async () => {
    const protectedRoutes = routes.filter((r) => r.policy === 'required');
    expect(protectedRoutes.length).toBeGreaterThan(0);
    for (const route of protectedRoutes) {
      const path = `/api/v1${route.path.replace(/:[A-Za-z0-9_]+/g, '0190a000-0000-7000-8000-00000000abcd')}`;
      const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      const res = await request(app.getHttpServer())[method](path);
      expect({ route: route.key, status: res.status, code: res.body?.error?.code }).toEqual({
        route: route.key,
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    }
  });
});

// --- Authorization matrix on test routes ------------------------------------------------------

@Controller('matrix')
class MatrixController {
  @Get('protected')
  read(@CurrentUser() user: RequestPrincipal): { userId: string } {
    return { userId: user.userId };
  }

  @Post('protected')
  create(@CurrentUser() user: RequestPrincipal): { userId: string } {
    return { userId: user.userId };
  }

  @Put('protected')
  replace(): { ok: true } {
    return { ok: true };
  }

  @Patch('protected')
  update(): { ok: true } {
    return { ok: true };
  }

  @Delete('protected')
  remove(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Post('public')
  open(): { ok: true } {
    return { ok: true };
  }

  @RequireVerifiedEmail()
  @Get('verified-only')
  verifiedOnly(@CurrentUser() user: RequestPrincipal): { userId: string } {
    return { userId: user.userId };
  }

  @Public({ session: 'optional' })
  @Post('optional')
  maybe(@CurrentUser({ optional: true }) user: RequestPrincipal | undefined): {
    userId: string | null;
  } {
    return { userId: user?.userId ?? null };
  }
}

@Module({ imports: [AppModule], controllers: [MatrixController] })
class MatrixModule {}

const TRUSTED = 'http://localhost:3000'; // CORS_ORIGINS default
type SessionCase = 'none' | 'unknown' | 'live';
type OriginCase = 'absent' | 'trusted' | 'foreign' | 'sibling' | 'cross-site-fetch';
type TokenCase = 'absent' | 'valid' | 'other-session' | 'garbage';

const COOKIE: Record<SessionCase, string | undefined> = {
  none: undefined,
  unknown: '__Host-session=unknown-token-cccccccccccccccccccccccccccccc',
  live: `__Host-session=${LIVE}`,
};
const TOKEN: Record<TokenCase, string | undefined> = {
  absent: undefined,
  valid: csrfTokenFor(LIVE),
  'other-session': csrfTokenFor(OTHER),
  garbage: 'g'.repeat(43),
};

/** The policy under test, written out independently of the guard's code. */
function expected(
  route: 'protected' | 'public' | 'optional',
  method: string,
  session: SessionCase,
  origin: OriginCase,
  token: TokenCase,
): number {
  const unsafe = method !== 'GET';
  const ok = method === 'POST' ? 201 : 200; // Nest's default success status
  if (unsafe && origin !== 'absent' && origin !== 'trusted') return 403;
  if (route === 'public') return ok;
  if (session !== 'live') return route === 'protected' ? 401 : ok;
  if (unsafe && token !== 'valid') return 403;
  return ok;
}

describe('authorization matrix (test routes, stubbed sessions)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrap(MatrixModule);
  }, 30_000);

  beforeEach(() => {
    lookups = 0;
    rateLimits.reset();
  });

  afterAll(async () => {
    await app?.close();
  });

  const sessions: SessionCase[] = ['none', 'unknown', 'live'];
  const origins: OriginCase[] = ['absent', 'trusted', 'foreign', 'sibling', 'cross-site-fetch'];
  const tokens: TokenCase[] = ['absent', 'valid', 'other-session', 'garbage'];
  const cases: [string, string, SessionCase, OriginCase, TokenCase][] = [];
  for (const [method, route] of [
    ['GET', 'protected'],
    ['POST', 'protected'],
    ['PUT', 'protected'],
    ['PATCH', 'protected'],
    ['DELETE', 'protected'],
    ['POST', 'public'],
    ['POST', 'optional'],
  ] as const) {
    for (const s of sessions)
      for (const o of origins)
        for (const t of tokens) {
          cases.push([method, route, s, o, t]);
        }
  }

  it.each(cases)('%s /matrix/%s session=%s origin=%s token=%s', async (method, route, s, o, t) => {
    let req = request(app.getHttpServer())[
      method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'
    ](`/api/v1/matrix/${route}`);
    if (COOKIE[s]) req = req.set('Cookie', COOKIE[s]);
    if (o === 'trusted') req = req.set('Origin', TRUSTED);
    if (o === 'foreign') req = req.set('Origin', 'https://attacker.example');
    if (o === 'sibling') req = req.set('Origin', 'http://evil.localhost:3000');
    if (o === 'cross-site-fetch') req = req.set('Sec-Fetch-Site', 'cross-site');
    if (TOKEN[t] !== undefined) req = req.set('X-CSRF-Token', TOKEN[t]);
    const res = await req;
    const want = expected(route as 'protected' | 'public' | 'optional', method, s, o, t);
    expect(res.status).toBe(want);
    if (want === 401) expect(res.body.error.code).toBe('UNAUTHENTICATED');
    if (want === 403) expect(res.body.error.code).toBe('CSRF_FAILED');
    if (want < 300 && route !== 'public' && s === 'live') {
      expect(res.body).toMatchObject(
        method === 'GET' || method === 'POST' ? { userId: sessionsByToken.get(LIVE)!.userId } : {},
      );
    }
  });

  it('never looks up a session on @Public() routes or for a rejected origin', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/matrix/public')
      .set('Cookie', COOKIE.live!)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/matrix/protected')
      .set('Cookie', COOKIE.live!)
      .set('Origin', 'https://attacker.example')
      .expect(403);
    expect(lookups).toBe(0);
  });

  it('@RequireVerifiedEmail(): 401 signed out, 403 EMAIL_NOT_VERIFIED unverified, 200 verified', async () => {
    const http = () => request(app.getHttpServer());
    await http().get('/api/v1/matrix/verified-only').expect(401);
    const unverified = await http()
      .get('/api/v1/matrix/verified-only')
      .set('Cookie', `__Host-session=${OTHER}`)
      .expect(403);
    expect(unverified.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    // Unverified users still reach ordinary protected routes (ADR-0021 interim policy).
    await http()
      .get('/api/v1/matrix/protected')
      .set('Cookie', `__Host-session=${OTHER}`)
      .expect(200);
    const verified = await http()
      .get('/api/v1/matrix/verified-only')
      .set('Cookie', COOKIE.live!)
      .expect(200);
    expect(verified.body).toEqual({ userId: sessionsByToken.get(LIVE)!.userId });
  });

  it('looks a session up once per request (rate limiter and guard share it)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/matrix/protected')
      .set('Cookie', COOKIE.live!)
      .expect(200);
    expect(lookups).toBe(1);
  });

  it('clears a cookie that no longer opens a session, and only then', async () => {
    const dead = await request(app.getHttpServer())
      .get('/api/v1/matrix/protected')
      .set('Cookie', COOKIE.unknown!)
      .expect(401);
    expect(dead.headers['set-cookie']?.[0]).toMatch(/^__Host-session=; Path=\/; Max-Age=0;/);
    const live = await request(app.getHttpServer())
      .get('/api/v1/matrix/protected')
      .set('Cookie', COOKIE.live!)
      .expect(200);
    expect(live.headers['set-cookie']).toBeUndefined();
  });

  it('lets allowed origins send the CSRF header cross-origin (CORS preflight)', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/v1/matrix/protected')
      .set('Origin', TRUSTED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token')
      .expect(204);
    expect(res.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
    const foreign = await request(app.getHttpServer())
      .options('/api/v1/matrix/protected')
      .set('Origin', 'https://attacker.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});
