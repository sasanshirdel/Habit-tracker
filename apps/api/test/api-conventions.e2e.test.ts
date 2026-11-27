import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Module,
  Param,
  Post,
  Query,
  type INestApplication,
} from '@nestjs/common';
import { paginationQuerySchema } from '@habit/shared-validation';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { createApp } from '../src/app.factory.js';
import {
  ApiException,
  ZodValidationPipe,
  currentRequestId,
  decodeCursor,
  paginate,
  sortSchema,
} from '../src/common/index.js';
import { QueueUnavailableError } from '../src/queue/errors.js';
import { Public } from '../src/common/auth/index.js';

// e2e for the API conventions (backlog P1-05): error envelope, validation, pagination and request
// ids, through the real global setup (`createApp`). A test-only controller is mounted next to the
// real AppModule; nothing here ships in the app. No database/Redis needed (see vitest.config.ts).

const ITEMS = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` }));
const cursorSchema = z.strictObject({ id: z.int().positive() });
const listQuerySchema = paginationQuerySchema.extend({
  sort: sortSchema(['id'], [{ field: 'id', direction: 'asc' }]),
});
const createItemSchema = z.strictObject({
  name: z.string().min(1).max(50),
  tags: z.array(z.string().max(20)).max(5).optional(),
});
const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

// Test-only routes: public, so these suites exercise conventions without a session (P2-03).
@Public()
@Controller('conventions-test')
class ConventionsTestController {
  @Get('items')
  list(@Query(new ZodValidationPipe(listQuerySchema)) query: z.output<typeof listQuerySchema>) {
    const desc = query.sort[0]?.direction === 'desc';
    const after = query.cursor ? decodeCursor(query.cursor, cursorSchema).id : undefined;
    const ordered = desc ? [...ITEMS].reverse() : ITEMS;
    // Keyset: rows strictly after the cursor in sort order, limit + 1 to detect a next page.
    const rows = ordered
      .filter((item) => after === undefined || (desc ? item.id < after : item.id > after))
      .slice(0, query.limit + 1);
    return paginate(rows, query.limit, (last) => ({ id: last.id }));
  }

  @Get('items/:id')
  get(@Param(new ZodValidationPipe(idParamsSchema)) params: z.output<typeof idParamsSchema>) {
    const item = ITEMS.find((i) => i.id === params.id);
    if (!item) throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Item not found.');
    return item;
  }

  @Post('items')
  create(@Body(new ZodValidationPipe(createItemSchema)) body: z.output<typeof createItemSchema>) {
    return { id: 99, ...body };
  }

  @Get('request-id')
  async requestId() {
    await new Promise((resolve) => setTimeout(resolve, 5)); // survives async boundaries
    return { requestId: currentRequestId() };
  }

  @Get('boom')
  boom(): never {
    throw new Error('connect failed: password=hunter2 host=10.0.0.9');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException('internal reason: user 42 is not in group admins');
  }

  @Get('queue-down')
  queueDown(): never {
    throw new QueueUnavailableError('not_connected');
  }
}

@Module({ imports: [AppModule], controllers: [ConventionsTestController] })
class ConventionsTestModule {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('API conventions (P1-05)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp(ConventionsTestModule);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Every error: envelope shape, stable code, requestId equal to the header, no internals. */
  function expectEnvelope(res: request.Response, status: number, code: string) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const requestId = res.headers['x-request-id'];
    expect(requestId).toEqual(expect.any(String));
    expect(res.body).toEqual({
      error: expect.objectContaining({ code, message: expect.any(String), requestId }),
    });
    expect(Object.keys(res.body.error).sort()).toEqual(
      expect.arrayContaining(['code', 'message', 'requestId']),
    );
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.(js|ts):\d+/);
  }

  describe('request ids', () => {
    it('adds a generated x-request-id to successful responses', async () => {
      const res = await http().get('/api/v1/health').expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID);
    });

    it('echoes a well-formed incoming x-request-id', async () => {
      const res = await http().get('/api/v1/health').set('x-request-id', 'edge-3f9a1c2b77');
      expect(res.headers['x-request-id']).toBe('edge-3f9a1c2b77');
    });

    it.each(['short', 'has spaces in it', '<script>alert(1)</script>', 'x'.repeat(200)])(
      'replaces a malformed incoming id (%j) with a new UUID',
      async (incoming) => {
        const res = await http().get('/api/v1/health').set('x-request-id', incoming);
        expect(res.headers['x-request-id']).toMatch(UUID);
      },
    );

    it('makes the id available to code handling the request, across async boundaries', async () => {
      const res = await http().get('/api/v1/conventions-test/request-id').expect(200);
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('gives concurrent requests distinct ids', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => http().get('/api/v1/conventions-test/request-id')),
      );
      const ids = responses.map((r) => r.body.requestId as string);
      expect(new Set(ids).size).toBe(10);
      for (const r of responses) expect(r.body.requestId).toBe(r.headers['x-request-id']);
    });
  });

  describe('validation', () => {
    it('400 VALIDATION_FAILED with field-level details for a missing field', async () => {
      const res = await http().post('/api/v1/conventions-test/items').send({});
      expectEnvelope(res, 400, 'VALIDATION_FAILED');
      expect(res.body.error.details).toEqual({
        issues: [{ field: 'body.name', code: 'invalid_type', message: expect.any(String) }],
      });
    });

    it('reports every problem, including unknown fields, without echoing values', async () => {
      const res = await http()
        .post('/api/v1/conventions-test/items')
        .send({ name: '', tags: ['ok', 'y'.repeat(21)], password: 'hunter2' });
      expectEnvelope(res, 400, 'VALIDATION_FAILED');
      const fields = res.body.error.details.issues.map((i: { field: string }) => i.field);
      expect(fields).toEqual(expect.arrayContaining(['body.name', 'body.tags.1', 'body.password']));
      const unknown = res.body.error.details.issues.find(
        (i: { field: string }) => i.field === 'body.password',
      );
      expect(unknown.code).toBe('unrecognized_keys');
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      expect(JSON.stringify(res.body)).not.toContain('y'.repeat(21));
    });

    it('validates query and path parameters too', async () => {
      const query = await http().get('/api/v1/conventions-test/items?limit=0');
      expectEnvelope(query, 400, 'VALIDATION_FAILED');
      expect(query.body.error.details.issues[0]).toMatchObject({ field: 'query.limit' });

      const param = await http().get('/api/v1/conventions-test/items/abc');
      expectEnvelope(param, 400, 'VALIDATION_FAILED');
      expect(param.body.error.details.issues[0]).toMatchObject({ field: 'param.id' });
    });

    it('passes the parsed, typed value to the handler', async () => {
      const res = await http()
        .post('/api/v1/conventions-test/items')
        .send({ name: 'Read 10 pages', tags: ['reading'] })
        .expect(201);
      expect(res.body).toEqual({ id: 99, name: 'Read 10 pages', tags: ['reading'] });
    });

    it('400 MALFORMED_REQUEST_BODY for invalid JSON', async () => {
      const res = await http()
        .post('/api/v1/conventions-test/items')
        .set('content-type', 'application/json')
        .send('{"name": "unterminated');
      expectEnvelope(res, 400, 'MALFORMED_REQUEST_BODY');
    });

    it('413 PAYLOAD_TOO_LARGE above the JSON body limit', async () => {
      const res = await http()
        .post('/api/v1/conventions-test/items')
        .send({ name: 'x', padding: 'p'.repeat(150 * 1024) });
      expectEnvelope(res, 413, 'PAYLOAD_TOO_LARGE');
    });
  });

  describe('error format', () => {
    it('404 NOT_FOUND for unknown routes, without echoing the path', async () => {
      const res = await http().get('/api/v1/does-not-exist-xyz');
      expectEnvelope(res, 404, 'NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('does-not-exist-xyz');
    });

    it('API exceptions keep their code and message', async () => {
      const res = await http().get('/api/v1/conventions-test/items/999');
      expectEnvelope(res, 404, 'NOT_FOUND');
      expect(res.body.error.message).toBe('Item not found.');
    });

    it('500 INTERNAL_ERROR for unexpected errors, with no internals', async () => {
      const res = await http().get('/api/v1/conventions-test/boom');
      expectEnvelope(res, 500, 'INTERNAL_ERROR');
      expect(res.body.error.message).toBe('Internal server error.');
      for (const leak of ['hunter2', '10.0.0.9', 'connect failed', 'Error']) {
        expect(JSON.stringify(res.body)).not.toContain(leak);
      }
    });

    it('framework HTTP exceptions get a stable code and a generic message', async () => {
      const res = await http().get('/api/v1/conventions-test/forbidden');
      expectEnvelope(res, 403, 'FORBIDDEN');
      expect(JSON.stringify(res.body)).not.toContain('admins');
    });

    it('QueueUnavailableError → 503 QUEUE_UNAVAILABLE', async () => {
      const res = await http().get('/api/v1/conventions-test/queue-down');
      expectEnvelope(res, 503, 'QUEUE_UNAVAILABLE');
    });

    it('readiness failures use the envelope too (503 NOT_READY)', async () => {
      const res = await http().get('/api/v1/health/ready');
      expectEnvelope(res, 503, 'NOT_READY');
    });
  });

  describe('cursor pagination', () => {
    it('pages through a list with limit and an opaque cursor', async () => {
      const first = await http().get('/api/v1/conventions-test/items?limit=3').expect(200);
      expect(first.body.data.map((i: { id: number }) => i.id)).toEqual([1, 2, 3]);
      expect(first.body.page).toEqual({
        nextCursor: expect.any(String),
        hasMore: true,
        limit: 3,
      });

      const second = await http()
        .get('/api/v1/conventions-test/items')
        .query({ limit: 3, cursor: first.body.page.nextCursor })
        .expect(200);
      expect(second.body.data.map((i: { id: number }) => i.id)).toEqual([4, 5, 6]);

      const last = await http()
        .get('/api/v1/conventions-test/items')
        .query({ limit: 3, cursor: second.body.page.nextCursor })
        .expect(200);
      expect(last.body.data.map((i: { id: number }) => i.id)).toEqual([7]);
      expect(last.body.page).toEqual({ nextCursor: null, hasMore: false, limit: 3 });
    });

    it('applies the default limit and a descending sort', async () => {
      const res = await http().get('/api/v1/conventions-test/items?sort=-id').expect(200);
      expect(res.body.data.map((i: { id: number }) => i.id)).toEqual([7, 6, 5, 4, 3, 2, 1]);
      expect(res.body.page).toEqual({ nextCursor: null, hasMore: false, limit: 20 });
    });

    it.each(['not-a-cursor!', 'bm9wZQ', Buffer.from('{"id":"x"}').toString('base64url')])(
      'rejects a malformed or tampered cursor (%s) with 400 INVALID_CURSOR',
      async (cursor) => {
        const res = await http().get('/api/v1/conventions-test/items').query({ cursor });
        expectEnvelope(res, 400, 'INVALID_CURSOR');
      },
    );

    it('rejects sorting by a field that is not whitelisted', async () => {
      const res = await http().get('/api/v1/conventions-test/items?sort=name');
      expectEnvelope(res, 400, 'VALIDATION_FAILED');
      expect(res.body.error.details.issues[0]).toMatchObject({ field: 'query.sort' });
    });
  });
});
