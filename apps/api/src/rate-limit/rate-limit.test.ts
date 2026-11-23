import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import type { RedisConnection } from '../queue/redis-connection.service.js';
import { RateLimitGuard, clientKey } from './rate-limit.guard.js';
import { RATE_LIMIT_CLASSES, resolvePolicy, type RateLimitPolicy } from './rate-limit.policies.js';
import {
  MemoryRateLimitStore,
  RateLimitStoreUnavailableError,
  RedisRateLimitStore,
  type RateLimitStore,
} from './rate-limit.store.js';

const config = (values: Partial<Env>) =>
  ({ get: (key: keyof Env) => values[key] }) as unknown as ConfigService<Env, true>;

describe('rate-limit policies', () => {
  it('pins the named classes (changing a number is a deliberate, reviewed change)', () => {
    expect(RATE_LIMIT_CLASSES).toEqual({
      default: {
        name: 'default',
        limit: 300,
        windowSeconds: 60,
        key: 'user-or-ip',
        onStoreFailure: 'allow',
      },
      auth: { name: 'auth', limit: 10, windowSeconds: 300, key: 'ip', onStoreFailure: 'deny' },
      expensive: {
        name: 'expensive',
        limit: 20,
        windowSeconds: 3600,
        key: 'user-or-ip',
        onStoreFailure: 'allow',
      },
    });
  });

  it('resolves class names and validates inline policies', () => {
    expect(resolvePolicy('auth')).toBe(RATE_LIMIT_CLASSES.auth);
    const ok: RateLimitPolicy = {
      name: 'test-x',
      limit: 1,
      windowSeconds: 1,
      key: 'ip',
      onStoreFailure: 'allow',
    };
    expect(resolvePolicy(ok)).toBe(ok);
    expect(() => resolvePolicy('nope' as never)).toThrow(/Unknown rate-limit class/);
    expect(() => resolvePolicy({ ...ok, name: 'Bad Name' })).toThrow(/policy name/);
    expect(() => resolvePolicy({ ...ok, name: 'a:b' })).toThrow(/policy name/);
    expect(() => resolvePolicy({ ...ok, limit: 0 })).toThrow(/limit/);
    expect(() => resolvePolicy({ ...ok, limit: 1.5 })).toThrow(/limit/);
    expect(() => resolvePolicy({ ...ok, windowSeconds: 0 })).toThrow(/windowSeconds/);
  });
});

describe('clientKey', () => {
  const { auth, default: def } = RATE_LIMIT_CLASSES;

  it('never contains the raw address or user id, and is namespaced by policy', () => {
    const key = clientKey(def, '203.0.113.7', undefined);
    expect(key).toMatch(/^default:[0-9a-f]{32}$/);
    expect(key).not.toContain('203.0.113.7');
    expect(clientKey(def, undefined, 'user-123')).not.toContain('user-123');
    expect(clientKey(auth, '203.0.113.7', undefined)).toMatch(/^auth:/);
  });

  it('is stable per identity and differs between identities', () => {
    expect(clientKey(def, '203.0.113.7', undefined)).toBe(clientKey(def, '203.0.113.7', undefined));
    expect(clientKey(def, '203.0.113.7', undefined)).not.toBe(
      clientKey(def, '203.0.113.8', undefined),
    );
  });

  it('keys `user-or-ip` policies by user once known, `ip` policies always by address', () => {
    // Two users behind one NAT get separate budgets…
    expect(clientKey(def, '198.51.100.1', 'u1')).not.toBe(clientKey(def, '198.51.100.1', 'u2'));
    // …one user keeps the same budget across addresses.
    expect(clientKey(def, '198.51.100.1', 'u1')).toBe(clientKey(def, '198.51.100.2', 'u1'));
    // Pre-auth classes ignore the user: the address is what is being throttled.
    expect(clientKey(auth, '198.51.100.1', 'u1')).toBe(clientKey(auth, '198.51.100.1', 'u2'));
  });
});

describe('MemoryRateLimitStore', () => {
  it('counts within a fixed window and resets when it ends', async () => {
    let now = 1_000;
    const store = new MemoryRateLimitStore(() => now);
    expect(await store.hit('k', 1_000)).toEqual({ count: 1, resetMs: 1_000 });
    now += 400;
    expect(await store.hit('k', 1_000)).toEqual({ count: 2, resetMs: 600 });
    expect(await store.hit('other', 1_000)).toEqual({ count: 1, resetMs: 1_000 });
    now += 600;
    expect(await store.hit('k', 1_000)).toEqual({ count: 1, resetMs: 1_000 });
  });
});

describe('RedisRateLimitStore', () => {
  const settings = config({ RATE_LIMIT_PREFIX: 'habit:rl' });
  const connection = (isReady: boolean, evalImpl: (...args: unknown[]) => Promise<unknown>) =>
    ({ isReady, client: { eval: vi.fn(evalImpl) } }) as unknown as RedisConnection;

  it('runs one atomic script under the prefix and maps the reply', async () => {
    const redis = connection(true, async () => [3, 41_500]);
    const store = new RedisRateLimitStore(redis, settings);
    expect(await store.hit('default:abc', 60_000)).toEqual({ count: 3, resetMs: 41_500 });
    const call = vi.mocked(redis.client.eval).mock.calls[0] as unknown[];
    expect(call.slice(1)).toEqual([1, 'habit:rl:default:abc', '60000']);
    expect(String(call[0])).toMatch(/INCR[\s\S]*PEXPIRE[\s\S]*PTTL/);
  });

  it('fails fast when Redis is not connected (never queues behind a reconnect)', async () => {
    const redis = connection(false, async () => [1, 1]);
    const store = new RedisRateLimitStore(redis, settings);
    await expect(store.hit('k', 1_000)).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    expect(redis.client.eval).not.toHaveBeenCalled();
  });

  it('gives up after its timeout', async () => {
    const store = new RedisRateLimitStore(
      connection(true, () => new Promise(() => undefined)),
      settings,
    );
    store.timeoutMs = 20;
    await expect(store.hit('k', 1_000)).rejects.toThrow(/timeout/);
  });

  it('rejects unexpected replies', async () => {
    const store = new RedisRateLimitStore(
      connection(true, async () => 'OK'),
      settings,
    );
    await expect(store.hit('k', 1_000)).rejects.toThrow(/bad_reply/);
  });
});

describe('RateLimitGuard (unit)', () => {
  const handler = () => undefined;
  class Ctl {}
  const http = (ip = '192.0.2.1') => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
    const ctx = {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => Ctl,
      switchToHttp: () => ({ getRequest: () => ({ ip }), getResponse: () => res }),
    } as unknown as ExecutionContext;
    return { ctx, headers };
  };

  it('does nothing when disabled (RATE_LIMIT_ENABLED=false)', async () => {
    const store: RateLimitStore = { hit: vi.fn() };
    const guard = new RateLimitGuard(new Reflector(), store, config({ RATE_LIMIT_ENABLED: false }));
    expect(await guard.canActivate(http().ctx)).toBe(true);
    expect(store.hit).not.toHaveBeenCalled();
  });

  it('ignores non-HTTP contexts', async () => {
    const store: RateLimitStore = { hit: vi.fn() };
    const guard = new RateLimitGuard(new Reflector(), store, config({ RATE_LIMIT_ENABLED: true }));
    const ctx = { getType: () => 'rpc' } as unknown as ExecutionContext;
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(store.hit).not.toHaveBeenCalled();
  });

  it('reports the remaining budget and allows requests within the limit', async () => {
    const store = new MemoryRateLimitStore(() => 0);
    const guard = new RateLimitGuard(new Reflector(), store, config({ RATE_LIMIT_ENABLED: true }));
    const { ctx, headers } = http();
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(headers).toEqual({
      'RateLimit-Limit': '300',
      'RateLimit-Remaining': '299',
      'RateLimit-Reset': '60',
    });
  });

  it('fails open for `allow` policies when the store is down', async () => {
    const store: RateLimitStore = {
      hit: vi.fn(async () => {
        throw new RateLimitStoreUnavailableError('not_connected');
      }),
    };
    const guard = new RateLimitGuard(new Reflector(), store, config({ RATE_LIMIT_ENABLED: true }));
    const { ctx, headers } = http();
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(headers).toEqual({});
  });
});
