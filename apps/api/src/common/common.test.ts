import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { QueueUnavailableError } from '../queue/errors.js';
import {
  ApiException,
  codeForStatus,
  currentRequestId,
  decodeCursor,
  encodeCursor,
  mapException,
  paginate,
  resolveRequestId,
  runWithRequestContext,
  sortSchema,
  toValidationIssues,
} from './index.js';

describe('mapException', () => {
  it('keeps code, message and details of ApiException', () => {
    expect(
      mapException(new ApiException(HttpStatus.CONFLICT, 'CONFLICT', 'Name taken.', { a: 1 })),
    ).toEqual({
      status: 409,
      error: { code: 'CONFLICT', message: 'Name taken.', details: { a: 1 } },
      unexpected: false,
    });
  });

  it('maps framework exceptions by status with a generic message', () => {
    expect(mapException(new NotFoundException('Cannot GET /secret/path'))).toEqual({
      status: 404,
      error: { code: 'NOT_FOUND', message: 'Not found.' },
      unexpected: false,
    });
  });

  it('maps body-parser errors, raw or wrapped by the Express adapter', () => {
    const raw = Object.assign(new SyntaxError('Unexpected token'), {
      type: 'entity.parse.failed',
      status: 400,
    });
    expect(mapException(raw).error.code).toBe('MALFORMED_REQUEST_BODY');
    expect(mapException(new BadRequestException('x', { cause: raw })).error.code).toBe(
      'MALFORMED_REQUEST_BODY',
    );
    const tooLarge = { type: 'entity.too.large', statusCode: 413 };
    expect(mapException(new PayloadTooLargeException('x', { cause: tooLarge }))).toMatchObject({
      status: 413,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('maps QueueUnavailableError to 503 QUEUE_UNAVAILABLE', () => {
    expect(mapException(new QueueUnavailableError('timeout'))).toMatchObject({
      status: 503,
      error: { code: 'QUEUE_UNAVAILABLE' },
      unexpected: false,
    });
  });

  it.each([new Error('password=hunter2'), 'a string', null, { weird: true }])(
    'turns anything else (%j) into an opaque 500 flagged as unexpected',
    (thrown) => {
      const mapped = mapException(thrown);
      expect(mapped).toEqual({
        status: 500,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
        unexpected: true,
      });
    },
  );

  it('flags 5xx HttpExceptions as unexpected', () => {
    expect(mapException(new HttpException('x', 502)).unexpected).toBe(true);
  });
});

describe('codeForStatus', () => {
  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [418, 'BAD_REQUEST'],
    [429, 'RATE_LIMITED'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'INTERNAL_ERROR'],
  ])('%i → %s', (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });
});

describe('toValidationIssues', () => {
  it('prefixes the location, splits unknown keys and never includes input values', () => {
    const schema = z.strictObject({ name: z.string().min(3), nested: z.object({ n: z.int() }) });
    const result = schema.safeParse({ name: 'ab', nested: { n: 1.5 }, secret: 's3cr3t', x: 1 });
    expect(result.success).toBe(false);
    const issues = toValidationIssues(result.error?.issues ?? [], 'body');
    expect(issues.map((i) => [i.field, i.code])).toEqual(
      expect.arrayContaining([
        ['body.name', 'too_small'],
        ['body.nested.n', 'invalid_type'],
        ['body.secret', 'unrecognized_keys'],
        ['body.x', 'unrecognized_keys'],
      ]),
    );
    expect(JSON.stringify(issues)).not.toContain('s3cr3t');
  });
});

describe('cursors', () => {
  const schema = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() });
  const position = {
    createdAt: '2026-11-24T10:00:00.000Z',
    id: '0195f2a4-6b1e-7c3d-8e9f-0a1b2c3d4e5f',
  };

  it('round-trips an opaque, URL-safe cursor', () => {
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, schema)).toEqual(position);
  });

  it.each(['', '***', 'bm90IGpzb24', encodeCursor({ id: 'nope' }), encodeCursor([1, 2])])(
    'rejects %j with INVALID_CURSOR',
    (cursor) => {
      expect(() => decodeCursor(cursor, schema)).toThrow(
        expect.objectContaining({ code: 'INVALID_CURSOR' }),
      );
    },
  );
});

describe('paginate', () => {
  it('trims the look-ahead row and points the cursor at the last returned row', () => {
    const page = paginate([1, 2, 3, 4], 3, (last) => ({ id: last }));
    expect(page.data).toEqual([1, 2, 3]);
    expect(page.page.hasMore).toBe(true);
    expect(decodeCursor(page.page.nextCursor ?? '', z.object({ id: z.int() }))).toEqual({ id: 3 });
  });

  it('has no next cursor on the last (or an empty) page', () => {
    expect(paginate([1, 2], 3, (x) => x).page).toEqual({
      nextCursor: null,
      hasMore: false,
      limit: 3,
    });
    expect(paginate([], 3, (x) => x)).toEqual({
      data: [],
      page: { nextCursor: null, hasMore: false, limit: 3 },
    });
  });
});

describe('sortSchema', () => {
  const schema = sortSchema(['createdAt', 'name'], [{ field: 'createdAt', direction: 'desc' }]);

  it('parses fields and directions, defaulting when absent', () => {
    expect(schema.parse('-createdAt,name')).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
    expect(schema.parse(undefined)).toEqual([{ field: 'createdAt', direction: 'desc' }]);
  });

  it.each(['password', 'name,name', '-', 'name,', '--name'])('rejects %j', (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe('request ids', () => {
  it('accepts well-formed incoming ids and replaces anything else', () => {
    expect(resolveRequestId('proxy-1234abcd')).toBe('proxy-1234abcd');
    for (const bad of [undefined, '', 'short', 'a b c d e f g h', 'x\r\nSet-Cookie: a', ['arr']]) {
      expect(resolveRequestId(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('exposes the id only inside the request context', async () => {
    expect(currentRequestId()).toBeUndefined();
    await runWithRequestContext({ requestId: 'req-abcdefgh' }, async () => {
      await Promise.resolve();
      expect(currentRequestId()).toBe('req-abcdefgh');
    });
    expect(currentRequestId()).toBeUndefined();
  });
});
