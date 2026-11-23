import 'reflect-metadata';
import { Body, Controller, Get, Logger, Module, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createApp } from '../src/app.factory.js';
import { JsonLogger, REDACTED, setRequestUserId } from '../src/common/index.js';

// e2e for structured logging (backlog P1-07) through the real global setup (`createApp`): every
// line is JSON, lines logged during a request carry its id (= the x-request-id header) and user,
// one access line per request, and nothing secret reaches the output. A test-only controller is
// mounted next to the real AppModule; nothing here ships in the app. No database/Redis needed.

const SECRETS = {
  password: 'hunter2-pw',
  token: 'tok-9f8e7d6c',
  email: 'person@example.com',
  journal: 'my very private journal text',
  bearer: 'bearer-cred-123456',
  cookie: 'sid-cookie-value',
  url: 'postgresql://admin:db-pass-55@db.internal/app',
};

@Controller('logging-test')
class LoggingTestController {
  private readonly logger = new Logger('LoggingTest');

  @Get('authenticated')
  async authenticated() {
    // What the authentication guard (P2-03) will do once the session is verified.
    setRequestUserId('user-0001');
    await new Promise((resolve) => setTimeout(resolve, 5)); // survives async boundaries
    this.logger.log('handled for user');
    return { ok: true };
  }

  @Post('sensitive')
  sensitive(@Body() body: Record<string, unknown>) {
    // Code must not log bodies; this proves the safety net if it ever does.
    this.logger.log({ msg: 'careless log', body, received: body, dsn: SECRETS.url });
    this.logger.warn(`retrying with token=${SECRETS.token} via ${SECRETS.url}`);
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error(`insert failed: (email)=(${SECRETS.email}) password=${SECRETS.password}`);
  }
}

@Module({ imports: [AppModule], controllers: [LoggingTestController] })
class LoggingTestModule {}

describe('structured logging (P1-07)', () => {
  const lines: string[] = [];
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const forRequest = (requestId: string) => records().filter((r) => r.requestId === requestId);
  /** Access lines are written on `finish`, which can land just after supertest resolves. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeAll(async () => {
    const logger = new JsonLogger({
      service: 'api',
      level: 'trace',
      format: 'json',
      includeErrorMessages: false, // production behaviour
      write: (line) => lines.push(line),
    });
    app = await createApp(LoggingTestModule, { logger });
    await app.init();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('writes only JSON lines with the standard fields', async () => {
    await http().get('/api/v1/health').expect(200);
    await settle();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record).toMatchObject({
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        level: expect.any(String),
        service: 'api',
        msg: expect.any(String),
      });
    }
  });

  it('adds the request id (equal to x-request-id) and the user id to lines logged in the request', async () => {
    const res = await http().get('/api/v1/logging-test/authenticated').expect(200);
    await settle();
    const requestId = res.headers['x-request-id'] as string;
    const own = forRequest(requestId);
    expect(own.find((r) => r.msg === 'handled for user')).toMatchObject({
      context: 'LoggingTest',
      requestId,
      userId: 'user-0001',
    });
    // The access line is written after the handler, so it carries the user too.
    expect(own.find((r) => r.context === 'HttpAccess')).toMatchObject({ userId: 'user-0001' });
  });

  it('keeps a caller-supplied, well-formed request id', async () => {
    await http()
      .get('/api/v1/logging-test/authenticated')
      .set('x-request-id', 'edge-proxy-req-0001')
      .expect(200);
    await settle();
    expect(forRequest('edge-proxy-req-0001').length).toBeGreaterThanOrEqual(2);
  });

  it('writes one access line per request with route pattern, status and duration only', async () => {
    const res = await http()
      .get('/api/v1/logging-test/authenticated?token=query-secret')
      .set('Authorization', `Bearer ${SECRETS.bearer}`)
      .set('Cookie', `sid=${SECRETS.cookie}`)
      .expect(200);
    await settle();
    const access = forRequest(res.headers['x-request-id'] as string).filter(
      (r) => r.context === 'HttpAccess',
    );
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      level: 'info',
      msg: 'request completed',
      http: {
        method: 'GET',
        route: '/api/v1/logging-test/authenticated',
        status: 200,
        durationMs: expect.any(Number),
      },
    });
    const output = lines.join('');
    for (const leak of ['query-secret', SECRETS.bearer, SECRETS.cookie]) {
      expect(output).not.toContain(leak);
    }
  });

  it('logs probe endpoints at debug and 404s with the path but no query string', async () => {
    const live = await http().get('/api/v1/health').expect(200);
    const ready = await http().get('/api/v1/health/ready');
    const missing = await http().get('/api/v1/nope/route?password=pw-in-query').expect(404);
    await settle();
    expect(
      forRequest(live.headers['x-request-id'] as string).find((r) => r.context === 'HttpAccess'),
    ).toMatchObject({ level: 'debug', http: { route: '/api/v1/health', status: 200 } });
    const readyAccess = forRequest(ready.headers['x-request-id'] as string).find(
      (r) => r.context === 'HttpAccess',
    );
    // Readiness is down in unit tests (no DB/Redis): 503 is an expected state, not an error line.
    expect(readyAccess).toMatchObject({ level: 'warn', http: { status: 503 } });
    expect(
      forRequest(ready.headers['x-request-id'] as string).some((r) => r.context === 'HttpError'),
    ).toBe(false);
    const missingAccess = forRequest(missing.headers['x-request-id'] as string).find(
      (r) => r.context === 'HttpAccess',
    );
    expect(missingAccess).toMatchObject({ http: { status: 404, path: '/api/v1/nope/route' } });
    expect(lines.join('')).not.toContain('pw-in-query');
  });

  it('redacts sensitive fields and credentials even when code logs them by mistake', async () => {
    const res = await http()
      .post('/api/v1/logging-test/sensitive')
      .send({
        password: SECRETS.password,
        accessToken: SECRETS.token,
        email: SECRETS.email,
        journal: { text: SECRETS.journal },
        nested: { deeper: { authorization: `Bearer ${SECRETS.bearer}` } },
        habitName: 'read 10 pages',
      })
      .expect(201);
    await settle();
    const own = forRequest(res.headers['x-request-id'] as string);
    const careless = own.find((r) => r.msg === 'careless log');
    expect(careless).toMatchObject({
      body: REDACTED,
      received: {
        password: REDACTED,
        accessToken: REDACTED,
        email: REDACTED,
        journal: REDACTED,
        nested: { deeper: { authorization: REDACTED } },
        habitName: 'read 10 pages',
      },
    });
    const output = lines.join('');
    for (const secret of Object.values(SECRETS)) expect(output).not.toContain(secret);
    expect(output).not.toContain('db-pass-55');
  });

  it('logs unexpected errors once, with code and stack frames but without the message', async () => {
    const res = await http().get('/api/v1/logging-test/boom').expect(500);
    await settle();
    const requestId = res.headers['x-request-id'] as string;
    const errors = forRequest(requestId).filter((r) => r.context === 'HttpError');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      level: 'error',
      code: 'INTERNAL_ERROR',
      status: 500,
      requestId,
      err: { name: 'Error', stack: expect.stringMatching(/^\s+at /) },
    });
    expect((errors[0]?.err as Record<string, unknown>).message).toBeUndefined();
    const output = lines.join('');
    for (const secret of [SECRETS.email, SECRETS.password, 'insert failed']) {
      expect(output).not.toContain(secret);
    }
    // The access line for the same request is a warning, not a second error.
    expect(forRequest(requestId).find((r) => r.context === 'HttpAccess')).toMatchObject({
      level: 'warn',
      http: { status: 500 },
    });
  });

  it('does not log expected client errors as errors', async () => {
    const res = await http()
      .post('/api/v1/logging-test/sensitive')
      .set('content-type', 'application/json')
      .send('{"password": "hunter2-pw"') // malformed JSON
      .expect(400);
    await settle();
    const own = forRequest(res.headers['x-request-id'] as string);
    expect(own.some((r) => r.level === 'error')).toBe(false);
    expect(lines.join('')).not.toContain(SECRETS.password);
  });
});
