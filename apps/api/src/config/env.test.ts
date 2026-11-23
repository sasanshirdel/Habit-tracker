import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

const DATABASE_URL = 'postgresql://user:pass@localhost:5432/db?schema=public';

describe('validateEnv', () => {
  it('applies safe defaults for local development', () => {
    const env = validateEnv({ DATABASE_URL });
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
  });

  it('parses comma-separated CORS origins and coerces the port', () => {
    const env = validateEnv({
      DATABASE_URL,
      API_PORT: '8080',
      CORS_ORIGINS: 'https://a.example, https://b.example',
    });
    expect(env.API_PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('requires DATABASE_URL (no implicit default database)', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it.each(['postgres://u:p@h:5432/d', 'postgresql://u:p@h/d'])(
    'accepts PostgreSQL URL %s',
    (url) => {
      expect(validateEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
    },
  );

  it.each(['mysql://u:p@h/d', 'https://example.com/db', 'not a url'])(
    'rejects non-PostgreSQL DATABASE_URL %s',
    (url) => {
      expect(() => validateEnv({ DATABASE_URL: url })).toThrow(/DATABASE_URL/);
    },
  );

  it('rejects invalid configuration without echoing values', () => {
    expect(() =>
      validateEnv({ API_PORT: 'not-a-port', DATABASE_URL: 'secret-but-invalid' }),
    ).toThrow(/API_PORT[\s\S]*DATABASE_URL/);
    const secret = 'mysql://admin:sup3r-secret@db.internal/prod';
    expect(() => validateEnv({ DATABASE_URL: secret })).toThrow();
    try {
      validateEnv({ DATABASE_URL: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain('sup3r-secret');
      expect((e as Error).message).not.toContain('db.internal');
    }
  });
});
