import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

describe('validateEnv', () => {
  it('applies safe defaults for local development', () => {
    const env = validateEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('parses comma-separated CORS origins and coerces the port', () => {
    const env = validateEnv({
      API_PORT: '8080',
      CORS_ORIGINS: 'https://a.example, https://b.example',
    });
    expect(env.API_PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects invalid configuration without echoing values', () => {
    expect(() =>
      validateEnv({ API_PORT: 'not-a-port', DATABASE_URL: 'secret-but-invalid' }),
    ).toThrow(/API_PORT[\s\S]*DATABASE_URL/);
    try {
      validateEnv({ DATABASE_URL: 'secret-but-invalid' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-but-invalid');
    }
  });
});
