import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_SECURITY_HEADERS } from '../src/common/security/security-headers.js';
import { validateOpenApiDocument } from '../src/openapi/openapi.validate.js';
import type { OpenApiDocument } from '../src/openapi/openapi.document.js';

// e2e for backlog P1-06 (ADR-0012): the OpenAPI document served by the real app setup
// (`createApp` → AppModule + `configureApp`). ConfigModule validates `process.env` when AppModule
// is first imported, so each scenario sets the environment, resets the module cache and imports
// the app afresh. PostgreSQL and Redis are unreachable here (vitest.config.ts); serving the
// document must not need either.

const DOCS = '/api/docs/openapi.json';
const ENV_KEYS = ['NODE_ENV', 'API_DOCS_ENABLED'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const key of ENV_KEYS) {
    const value = key in env ? env[key] : saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Boots the app with `env` applied before AppModule (and so ConfigModule) is imported. */
async function bootWith(
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
): Promise<INestApplication> {
  setEnv(env);
  vi.resetModules();
  const [{ createApp }, { createLogger }] = await Promise.all([
    import('../src/app.factory.js'),
    import('../src/common/logging/json-logger.js'),
  ]);
  // Quiet logger: the production scenario would otherwise print its startup warning.
  const app = await createApp(undefined, { logger: createLogger('api', { LOG_LEVEL: 'error' }) });
  await app.init();
  return app;
}

afterEach(() => setEnv({}));

describe('GET /api/docs/openapi.json when enabled (NODE_ENV=test, API_DOCS_ENABLED unset)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootWith({ NODE_ENV: 'test', API_DOCS_ENABLED: undefined });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('serves a valid OpenAPI 3.1 JSON document documenting the routes', async () => {
    const res = await request(app.getHttpServer()).get(DOCS).expect(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    const doc = res.body as OpenApiDocument;
    expect(validateOpenApiDocument(doc)).toEqual([]);
    expect(doc.openapi).toBe('3.1.1');
    expect(doc.servers).toEqual([{ url: '/api/v1', description: expect.any(String) }]);
    expect(Object.keys(doc.paths)).toEqual([
      '/auth/login',
      '/auth/logout',
      '/auth/logout-everywhere',
      '/auth/register',
      '/auth/session',
      '/health',
      '/health/ready',
    ]);
  });

  it('carries the API security headers and a request id', async () => {
    const res = await request(app.getHttpServer())
      .get(DOCS)
      .set('x-request-id', 'docs-test-req-0001')
      .expect(200);
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      expect(res.headers[name.toLowerCase()], name).toBe(value);
    }
    expect(res.headers['x-request-id']).toBe('docs-test-req-0001');
    expect(res.headers['x-powered-by']).toBeUndefined();
    const generated = await request(app.getHttpServer()).get(DOCS);
    expect(generated.headers['x-request-id']).toEqual(expect.any(String));
    expect(generated.headers['x-request-id']).not.toBe('docs-test-req-0001');
  });

  it('serves the same cached document on every request and is not rate-limited', async () => {
    const first = await request(app.getHttpServer()).get(DOCS).expect(200);
    const second = await request(app.getHttpServer()).get(DOCS).expect(200);
    expect(second.text).toBe(first.text);
    // The document is served outside Nest's guards: no rate-limit headers (ADR-0012).
    expect(second.headers['ratelimit-limit']).toBeUndefined();
  });

  it('does not leak configuration or connection details', async () => {
    const res = await request(app.getHttpServer()).get(DOCS).expect(200);
    for (const fragment of ['127.0.0.1', 'postgresql://', 'redis://', 'unreachable']) {
      expect(res.text).not.toContain(fragment);
    }
  });

  it('is only served at its own path, not under the versioned prefix', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/docs/openapi.json').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe.each([
  { name: 'API_DOCS_ENABLED=false', env: { NODE_ENV: 'test', API_DOCS_ENABLED: 'false' } },
  { name: 'NODE_ENV=production', env: { NODE_ENV: 'production', API_DOCS_ENABLED: undefined } },
])('GET /api/docs/openapi.json when disabled ($name)', ({ env }) => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootWith(env);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('answers 404 NOT_FOUND in the standard envelope, with security headers', async () => {
    const res = await request(app.getHttpServer()).get(DOCS).expect(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Not found.',
        requestId: res.headers['x-request-id'],
      },
    });
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      expect(res.headers[name.toLowerCase()], name).toBe(value);
    }
    expect(res.text).not.toContain('openapi');
  });
});

describe('GET /api/docs/openapi.json in production with API_DOCS_ENABLED=true', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootWith({ NODE_ENV: 'production', API_DOCS_ENABLED: 'true' });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('serves the document only because it was explicitly enabled', async () => {
    const res = await request(app.getHttpServer()).get(DOCS).expect(200);
    expect(validateOpenApiDocument(res.body as OpenApiDocument)).toEqual([]);
  });
});
