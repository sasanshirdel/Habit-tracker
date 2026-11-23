import { describe, expect, it } from 'vitest';
import { validateEnv, validateWorkerEnv } from './env.js';

const DATABASE_URL = 'postgresql://user:pass@localhost:5432/db?schema=public';
const REDIS_URL = 'redis://localhost:6379';
const required = { DATABASE_URL, REDIS_URL };

describe('validateEnv', () => {
  it('applies safe defaults for local development', () => {
    const env = validateEnv(required);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
    expect(env.REDIS_URL).toBe(REDIS_URL);
    expect(env.QUEUE_PREFIX).toBe('habit:q');
  });

  it('parses comma-separated CORS origins and coerces the port', () => {
    const env = validateEnv({
      ...required,
      API_PORT: '8080',
      CORS_ORIGINS: 'https://a.example, https://b.example',
    });
    expect(env.API_PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('requires DATABASE_URL (no implicit default database)', () => {
    expect(() => validateEnv({ REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it('requires REDIS_URL (queues need Redis — P1-03)', () => {
    expect(() => validateEnv({ DATABASE_URL })).toThrow(/REDIS_URL/);
  });

  it.each(['postgres://u:p@h:5432/d', 'postgresql://u:p@h/d'])(
    'accepts PostgreSQL URL %s',
    (url) => {
      expect(validateEnv({ ...required, DATABASE_URL: url }).DATABASE_URL).toBe(url);
    },
  );

  it.each(['mysql://u:p@h/d', 'https://example.com/db', 'not a url'])(
    'rejects non-PostgreSQL DATABASE_URL %s',
    (url) => {
      expect(() => validateEnv({ ...required, DATABASE_URL: url })).toThrow(/DATABASE_URL/);
    },
  );

  it.each(['redis://localhost:6379', 'rediss://user:pw@redis.example:6380/2'])(
    'accepts Redis URL %s',
    (url) => {
      expect(validateEnv({ ...required, REDIS_URL: url }).REDIS_URL).toBe(url);
    },
  );

  it.each(['http://localhost:6379', 'localhost:6379x', 'not a url'])(
    'rejects non-Redis REDIS_URL %s',
    (url) => {
      expect(() => validateEnv({ ...required, REDIS_URL: url })).toThrow(/REDIS_URL/);
    },
  );

  it.each(['habit:q', 'habit:it:abc_12:q', 'q'])('accepts QUEUE_PREFIX %s', (prefix) => {
    expect(validateEnv({ ...required, QUEUE_PREFIX: prefix }).QUEUE_PREFIX).toBe(prefix);
  });

  it.each(['', ':habit', 'habit:', 'habit::q', 'ha bit', 'habit*'])(
    'rejects QUEUE_PREFIX %j',
    (prefix) => {
      expect(() => validateEnv({ ...required, QUEUE_PREFIX: prefix })).toThrow(/QUEUE_PREFIX/);
    },
  );

  it('rejects invalid configuration without echoing values', () => {
    // Every problem is reported at once (order follows the schema, not the input).
    const invalid = () =>
      validateEnv({ API_PORT: 'not-a-port', DATABASE_URL: 'secret-but-invalid', REDIS_URL });
    expect(invalid).toThrow(/API_PORT/);
    expect(invalid).toThrow(/DATABASE_URL/);
    for (const env of [
      { DATABASE_URL: 'mysql://admin:sup3r-secret@db.internal/prod', REDIS_URL },
      { DATABASE_URL, REDIS_URL: 'http://admin:sup3r-secret@db.internal:6379' },
    ]) {
      let message = '';
      try {
        validateEnv(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/Invalid environment configuration/);
      expect(message).not.toContain('sup3r-secret');
      expect(message).not.toContain('db.internal');
    }
  });
});

describe('validateWorkerEnv', () => {
  it('applies worker defaults and does not require API-only settings', () => {
    const env = validateWorkerEnv(required);
    expect(env.WORKER_CONCURRENCY).toBe(5);
    expect(env.WORKER_SHUTDOWN_TIMEOUT_MS).toBe(25_000);
    expect(env.QUEUE_PREFIX).toBe('habit:q');
    expect(env).not.toHaveProperty('API_PORT');
  });

  it('coerces and bounds worker settings', () => {
    const env = validateWorkerEnv({
      ...required,
      WORKER_CONCURRENCY: '2',
      WORKER_SHUTDOWN_TIMEOUT_MS: '5000',
    });
    expect(env.WORKER_CONCURRENCY).toBe(2);
    expect(env.WORKER_SHUTDOWN_TIMEOUT_MS).toBe(5000);
    expect(() => validateWorkerEnv({ ...required, WORKER_CONCURRENCY: '0' })).toThrow(
      /WORKER_CONCURRENCY/,
    );
    expect(() => validateWorkerEnv({ ...required, WORKER_SHUTDOWN_TIMEOUT_MS: '10' })).toThrow(
      /WORKER_SHUTDOWN_TIMEOUT_MS/,
    );
  });

  it('requires the same connection settings as the API', () => {
    expect(() => validateWorkerEnv({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });
});
