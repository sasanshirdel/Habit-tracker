import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { runWithRequestContext, setRequestUserId } from '../request/request-context.js';
import { accessLogFields } from './access-log.middleware.js';
import { JsonLogger, createLogger, type JsonLoggerOptions } from './json-logger.js';
import { runWithJobContext } from './log-context.js';
import { logSettingsFromEnv } from './log-settings.js';
import {
  MAX_ARRAY_ITEMS,
  MAX_STRING_LENGTH,
  REDACTED,
  SAFE_MESSAGE,
  isSensitiveKey,
  redact,
  scrubText,
  serializeError,
} from './redact.js';

// Unit tests for structured logging and redaction (backlog P1-07).

const strict = { includeMessages: false };
const FIXED = new Date('2026-01-02T03:04:05.000Z');

function capture(overrides: Partial<JsonLoggerOptions> = {}) {
  const lines: string[] = [];
  const logger = new JsonLogger({
    service: 'api',
    level: 'trace',
    format: 'json',
    includeErrorMessages: false,
    write: (line) => lines.push(line),
    now: () => FIXED,
    ...overrides,
  });
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines, records };
}

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'newPassword',
    'displayName',
    'display_name',
    'password_confirmation',
    'clientSecret',
    'accessToken',
    'refresh_token',
    'csrfToken',
    'token',
    'Authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'apiKey',
    'privateKey',
    'credentials',
    'cardNumber',
    'cvv',
    'iban',
    'journalEntry',
    'signature',
    'recoveryCodes',
    'DATABASE_URL',
    'redisUrl',
    'session',
    // Identity columns (P2-01, ADR-0017)
    'passwordHash',
    'password_hash',
    'tokenHash',
    'token_hash',
    'sid',
    'otp',
    'pin',
    'pan',
    'body',
    'content',
    'text',
    'notes',
    'prompt',
    'completion',
    'email',
    'phoneNumber',
    'mood',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'userId',
    'jobId',
    'requestId',
    'status',
    'durationMs',
    'method',
    'route',
    'habitId',
    'tokenCount',
    'inputTokens',
    'outputTokens',
    'tokenType',
    'company',
    'spinner',
    'code',
  ])('keeps %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('scrubText', () => {
  it.each([
    ['postgresql://admin:sup3r-secret@db.internal:5432/app', 'sup3r-secret'],
    ['redis://:sup3r-secret@cache:6379', 'sup3r-secret'],
    ['Authorization: Bearer abc.def-ghi_jkl', 'abc.def-ghi_jkl'],
    ['Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl here', 'eyJzdWIiOiIxMjMifQ'],
    ['/reset?token=abc123&lang=fa', 'abc123'],
    ['password=hunter2; path=/', 'hunter2'],
    ['api_key=k-123 next', 'k-123'],
    ['session=s%3Aabc', 's%3Aabc'],
  ])('masks credentials in %j', (text, secret) => {
    const out = scrubText(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it('leaves ordinary text alone', () => {
    const text =
      'Consuming queue "system" (system.noop), concurrency 5. lang=fa https://example.com/a?b=c';
    expect(scrubText(text)).toBe(text);
  });

  it('truncates very long strings', () => {
    const out = scrubText('x'.repeat(MAX_STRING_LENGTH + 100));
    expect(out.length).toBeLessThan(MAX_STRING_LENGTH + 20);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });
});

describe('redact', () => {
  it('masks sensitive keys at any depth, including arrays', () => {
    const out = redact(
      {
        user: { id: 'u1', email: 'a@example.com', profile: { password: 'hunter2' } },
        headers: { authorization: 'Bearer t', cookie: 'sid=abc', 'user-agent': 'ua' },
        items: [{ cardNumber: '4111111111111111', amount: 1000 }],
        payment: { iban: 'IR000000000000000000000000', currency: 'IRR' },
        journal: { text: 'my private thoughts' },
      },
      strict,
    );
    expect(out).toEqual({
      user: { id: 'u1', email: REDACTED, profile: { password: REDACTED } },
      headers: { authorization: REDACTED, cookie: REDACTED, 'user-agent': 'ua' },
      items: [{ cardNumber: REDACTED, amount: 1000 }],
      payment: { iban: REDACTED, currency: 'IRR' },
      journal: REDACTED,
    });
    const json = JSON.stringify(out);
    for (const secret of ['hunter2', 'a@example.com', '4111111111111111', 'private thoughts']) {
      expect(json).not.toContain(secret);
    }
  });

  it('scrubs credentials inside non-sensitive string fields', () => {
    expect(redact({ url: 'redis://u:pw-1@h:6379' }, strict)).toEqual({
      url: `redis://${REDACTED}@h:6379`,
    });
  });

  it('breaks cycles, bounds depth and array length, summarises special values', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const out = redact(
      {
        cyclic,
        deep,
        list: Array.from({ length: MAX_ARRAY_ITEMS + 5 }, (_, i) => i),
        when: new Date('2026-01-01T00:00:00Z'),
        big: 10n,
        buf: Buffer.from('secret bytes'),
        fn: () => 1,
        map: new Map([['k', 'v']]),
      },
      strict,
    ) as Record<string, unknown>;
    expect(out.cyclic).toEqual({ name: 'a', self: '[Circular]' });
    expect(JSON.stringify(out.deep)).toContain('[Truncated]');
    expect((out.list as unknown[]).length).toBe(MAX_ARRAY_ITEMS + 1);
    expect((out.list as unknown[]).at(-1)).toBe('[+5 more]');
    expect(out.when).toBe('2026-01-01T00:00:00.000Z');
    expect(out.big).toBe('10');
    expect(out.buf).toBe('[Binary 12 bytes]');
    expect(out).not.toHaveProperty('fn');
    expect(out.map).toBe('[Map size=1]');
  });

  it('serialises errors nested in fields', () => {
    const out = redact({ err: new TypeError('value "hunter2" is wrong') }, strict) as {
      err: { name: string; message?: string };
    };
    expect(out.err.name).toBe('TypeError');
    expect(out.err.message).toBeUndefined();
  });
});

describe('serializeError', () => {
  const error = Object.assign(new Error('duplicate key value (email)=(a@example.com)'), {
    code: 'P2002',
  });

  it('keeps name, code and stack frames but drops the message by default', () => {
    const out = serializeError(error, strict);
    expect(out.name).toBe('Error');
    expect(out.code).toBe('P2002');
    expect(out.message).toBeUndefined();
    expect(out.stack).toMatch(/^\s+at /);
    expect(JSON.stringify(out)).not.toContain('a@example.com');
  });

  it('includes the (scrubbed) message when allowed (development)', () => {
    const withUrl = new Error('connect failed for postgresql://u:pw-9@db/app');
    const out = serializeError(withUrl, { includeMessages: true });
    expect(out.message).toContain('connect failed');
    expect(JSON.stringify(out)).not.toContain('pw-9');
  });

  it('includes messages marked SAFE_MESSAGE (e.g. configuration errors)', () => {
    const safe = Object.assign(new Error('Invalid environment configuration: LOG_LEVEL'), {
      [SAFE_MESSAGE]: true,
    });
    expect(serializeError(safe, strict).message).toContain('LOG_LEVEL');
  });

  it('follows causes a few levels deep', () => {
    const outer = new Error('outer', { cause: new RangeError('inner secret') });
    const out = serializeError(outer, strict);
    expect(out.cause).toMatchObject({ name: 'RangeError' });
    expect(JSON.stringify(out)).not.toContain('inner secret');
  });
});

describe('JsonLogger', () => {
  it('writes one JSON object per line with time, level, service, context and msg', () => {
    const { logger, lines, records } = capture();
    logger.log('Worker started.', 'WorkerProcess');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(records()[0]).toEqual({
      time: FIXED.toISOString(),
      level: 'info',
      service: 'api',
      context: 'WorkerProcess',
      msg: 'Worker started.',
    });
  });

  it('maps Nest levels and filters below the configured level', () => {
    const { logger, records } = capture({ level: 'warn' });
    logger.verbose('v');
    logger.debug('d');
    logger.log('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');
    expect(records().map((r) => r.level)).toEqual(['warn', 'error', 'fatal']);
  });

  it('supports Nest setLogLevels', () => {
    const { logger, records } = capture({ level: 'trace' });
    logger.setLogLevels(['error', 'warn']);
    logger.log('hidden');
    logger.warn('shown');
    expect(records().map((r) => r.msg)).toEqual(['shown']);
  });

  it('adds requestId and userId inside a request context', () => {
    const { logger, records } = capture();
    logger.log('outside');
    runWithRequestContext({ requestId: 'req-12345678' }, () => {
      logger.log('before auth');
      setRequestUserId('user-1');
      logger.log('after auth');
    });
    const [outside, before, after] = records();
    expect(outside).not.toHaveProperty('requestId');
    expect(before).toMatchObject({ requestId: 'req-12345678' });
    expect(before).not.toHaveProperty('userId');
    expect(after).toMatchObject({ requestId: 'req-12345678', userId: 'user-1' });
  });

  it('setRequestUserId is a no-op outside a request', () => {
    expect(() => setRequestUserId('user-1')).not.toThrow();
  });

  it('adds jobId, jobName and attempt inside a job context', () => {
    const { logger, records } = capture({ service: 'worker' });
    runWithJobContext({ jobId: '7', jobName: 'system.noop', attempt: 2 }, () =>
      logger.debug('working'),
    );
    expect(records()[0]).toMatchObject({
      service: 'worker',
      jobId: '7',
      jobName: 'system.noop',
      attempt: 2,
    });
  });

  it('merges object messages as fields and redacts them', () => {
    const { logger, lines, records } = capture();
    logger.log(
      { msg: 'login attempt', email: 'a@example.com', password: 'hunter2', attemptNo: 3 },
      'Auth',
    );
    expect(records()[0]).toEqual({
      time: FIXED.toISOString(),
      level: 'info',
      service: 'api',
      context: 'Auth',
      msg: 'login attempt',
      email: REDACTED,
      password: REDACTED,
      attemptNo: 3,
    });
    expect(lines.join('')).not.toContain('hunter2');
  });

  it('scrubs credentials in messages', () => {
    const { logger, lines } = capture();
    logger.warn('could not reach redis://default:pw-77@cache.internal:6379', 'Redis');
    expect(lines.join('')).not.toContain('pw-77');
  });

  it('does not let fields overwrite reserved keys', () => {
    const { logger, records } = capture();
    runWithRequestContext({ requestId: 'req-real-0001' }, () =>
      logger.log({ msg: 'm', level: 'fatal', requestId: 'forged-id', time: 'x', service: 'evil' }),
    );
    expect(records()[0]).toMatchObject({
      level: 'info',
      requestId: 'req-real-0001',
      time: FIXED.toISOString(),
      service: 'api',
    });
  });

  it('logs errors without their message outside development', () => {
    const { logger, lines, records } = capture();
    const error = new Error('insert failed: email=a@example.com');
    logger.error(error, 'HttpError');
    logger.error('Unhandled', error.stack, 'HttpError');
    const [asObject, asStack] = records();
    expect(asObject).toMatchObject({ level: 'error', msg: 'Error', context: 'HttpError' });
    expect(asObject?.err).toMatchObject({ name: 'Error' });
    expect(asStack).toMatchObject({ msg: 'Unhandled', context: 'HttpError' });
    expect(String(asStack?.stack)).toMatch(/^\s+at /);
    expect(lines.join('')).not.toContain('a@example.com');
  });

  it('includes error messages in development', () => {
    const { logger, records } = capture({ includeErrorMessages: true });
    logger.error(new Error('helpful detail'));
    expect(records()[0]?.err).toMatchObject({ message: 'helpful detail' });
  });

  it('handles Nest Logger.error padding (undefined stack + context)', () => {
    const { logger, records } = capture();
    logger.error('boom', undefined, 'Ctx');
    expect(records()[0]).toEqual({
      time: FIXED.toISOString(),
      level: 'error',
      service: 'api',
      context: 'Ctx',
      msg: 'boom',
    });
  });

  it('renders a readable, still redacted line in pretty format', () => {
    const { logger, lines } = capture({ format: 'pretty' });
    logger.warn({ msg: 'slow', durationMs: 900, token: 't-1' }, 'HttpAccess');
    expect(lines[0]).toBe(
      `${FIXED.toISOString()} WARN  [HttpAccess] slow {"durationMs":900,"token":"${REDACTED}"}\n`,
    );
  });

  it('never throws when the destination fails', () => {
    const logger = new JsonLogger({
      service: 'api',
      level: 'info',
      format: 'json',
      includeErrorMessages: false,
      write: () => {
        throw new Error('EPIPE');
      },
    });
    expect(() => logger.log('x')).not.toThrow();
  });

  describe('as Nest logger', () => {
    afterEach(() => Logger.overrideLogger(['error', 'warn', 'log']));

    it('receives `new Logger(Context)` calls with the context name', () => {
      const { logger, records } = capture();
      Logger.overrideLogger(logger);
      new Logger('Sample').warn('hello');
      new Logger('Sample').error('failed');
      expect(records()).toEqual([
        expect.objectContaining({ level: 'warn', context: 'Sample', msg: 'hello' }),
        expect.objectContaining({ level: 'error', context: 'Sample', msg: 'failed' }),
      ]);
    });
  });
});

describe('logSettingsFromEnv / createLogger', () => {
  it('defaults by NODE_ENV', () => {
    expect(logSettingsFromEnv({ NODE_ENV: 'development' })).toEqual({
      level: 'debug',
      format: 'json',
      includeErrorMessages: true,
    });
    expect(logSettingsFromEnv({ NODE_ENV: 'production' })).toEqual({
      level: 'info',
      format: 'json',
      includeErrorMessages: false,
    });
    expect(logSettingsFromEnv({ NODE_ENV: 'test' }).includeErrorMessages).toBe(false);
  });

  it('never includes error messages unless development is explicit', () => {
    expect(logSettingsFromEnv({}).includeErrorMessages).toBe(false);
  });

  it('honours LOG_LEVEL and LOG_FORMAT, falling back on invalid values', () => {
    expect(
      logSettingsFromEnv({ NODE_ENV: 'production', LOG_LEVEL: 'warn', LOG_FORMAT: 'pretty' }),
    ).toMatchObject({ level: 'warn', format: 'pretty' });
    expect(logSettingsFromEnv({ NODE_ENV: 'production', LOG_LEVEL: 'loud' })).toMatchObject({
      level: 'info',
      format: 'json',
    });
  });

  it('creates a logger for the given service', () => {
    const logger = createLogger('worker', { NODE_ENV: 'production', LOG_LEVEL: 'error' });
    expect(logger.isLevelEnabled('warn')).toBe(false);
    expect(logger.isLevelEnabled('error')).toBe(true);
  });
});

describe('accessLogFields', () => {
  it('uses the matched route pattern, never the raw path or query', () => {
    const req = {
      method: 'GET',
      url: '/api/v1/habits/123?token=abc',
      baseUrl: '',
      route: { path: '/api/v1/habits/:id' },
    } as never;
    expect(accessLogFields(req, 200, 12.345, false)).toEqual({
      msg: 'request completed',
      http: { method: 'GET', route: '/api/v1/habits/:id', status: 200, durationMs: 12.3 },
    });
  });

  it('falls back to the truncated path without query string when no route matched', () => {
    const long = `/${'a'.repeat(300)}`;
    const req = { method: 'POST', url: `${long}?password=x` } as never;
    const fields = accessLogFields(req, 404, 1, false);
    expect(fields.http.route).toBeUndefined();
    expect(fields.http.path?.length).toBe(201);
    expect(JSON.stringify(fields)).not.toContain('password');
  });

  it('adds the raw path for wildcard routes (Nest not-found catch-all)', () => {
    const req = {
      method: 'GET',
      url: '/api/v1/nope?x=1',
      route: { path: '/api/v1*path' },
    } as never;
    expect(accessLogFields(req, 404, 1, false).http).toMatchObject({
      route: '/api/v1*path',
      path: '/api/v1/nope',
    });
  });

  it('marks aborted requests', () => {
    const req = { method: 'GET', url: '/x' } as never;
    expect(accessLogFields(req, 200, 5, true)).toMatchObject({
      msg: 'request aborted',
      http: { aborted: true },
    });
  });
});
