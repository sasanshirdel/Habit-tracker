import 'reflect-metadata';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type * as RateLimitApi from '../src/rate-limit/index.js';
import { RespClient } from './integration/redis-resp.js';

// Integration (backlog P1-08): the rate-limit guard with its real Redis store, through the real app
// (`createApp` + AppModule). Counters live under the run's key prefix (RATE_LIMIT_PREFIX is set by
// global setup), which global teardown deletes.
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');

/** All keys under `pattern` (SCAN, never KEYS). */
async function scanKeys(redis: RespClient, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const reply = (await redis.command(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500'])) as [
      string,
      string[],
    ];
    cursor = String(reply[0]);
    keys.push(...reply[1].map(String));
  } while (cursor !== '0');
  return keys;
}

describe('rate limiting with Redis (real Redis)', () => {
  let app: INestApplication;
  let redis: RespClient;
  let api: typeof RateLimitApi;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.RATE_LIMIT_PREFIX = `${keyPrefix}rl`;
    // Imported lazily: ConfigModule validates env when the modules are first evaluated.
    api = await import('../src/rate-limit/index.js');
    const { AppModule } = await import('../src/app.module.js');
    const { createApp } = await import('../src/app.factory.js');
    const { RateLimit } = api;
    const { Public } = await import('../src/common/auth/index.js');

    @Public()
    @Controller('rl-int')
    class RateLimitIntController {
      @RateLimit({
        name: 'int-tight',
        limit: 2,
        windowSeconds: 30,
        key: 'ip',
        onStoreFailure: 'deny',
      })
      @Get('tight')
      tight() {
        return { ok: true };
      }

      @RateLimit({
        name: 'int-short',
        limit: 1,
        windowSeconds: 1,
        key: 'ip',
        onStoreFailure: 'deny',
      })
      @Get('short')
      short() {
        return { ok: true };
      }
    }

    @Module({ imports: [AppModule], controllers: [RateLimitIntController] })
    class RateLimitIntModule {}

    app = await createApp(RateLimitIntModule);
    await app.init();
    const { RedisConnection } = await import('../src/queue/index.js');
    const connection = app.get(RedisConnection);
    for (let i = 0; i < 100 && !connection.isReady; i++)
      await new Promise((r) => setTimeout(r, 50));
    redis = await RespClient.connect(redisUrl);
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
  });

  it('counts in Redis across requests and answers 429 with Retry-After', async () => {
    await http().get('/api/v1/rl-int/tight').expect(200);
    const second = await http().get('/api/v1/rl-int/tight').expect(200);
    expect(second.headers['ratelimit-remaining']).toBe('0');
    const res = await http().get('/api/v1/rl-int/tight').expect(429);
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect(res.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: retryAfter, policy: 'int-tight' },
    });
  });

  it('stores counters only under RATE_LIMIT_PREFIX, hashed, with a TTL', async () => {
    const keys = await scanKeys(redis, `${keyPrefix}rl:*`);
    expect(keys.length).toBeGreaterThanOrEqual(2); // default + int-tight
    for (const key of keys) {
      expect(key).toMatch(new RegExp(`^${keyPrefix}rl:[a-z0-9-]+:[0-9a-f]{32}$`));
      expect(key).not.toMatch(/127\.0\.0\.1|::1|::ffff/);
      const ttl = Number(await redis.command(['PTTL', key]));
      expect(ttl).toBeGreaterThan(0);
    }
    const tight = keys.find((k) => k.includes(':int-tight:')) as string;
    expect(await redis.command(['GET', tight])).toBe('3');
    expect(Number(await redis.command(['PTTL', tight]))).toBeLessThanOrEqual(30_000);
    // Nothing written to the default namespace of a shared Redis.
    expect(await scanKeys(redis, 'habit:rl:*')).toEqual([]);
  });

  it('opens a new window when the previous one expires', async () => {
    await http().get('/api/v1/rl-int/short').expect(200);
    await http().get('/api/v1/rl-int/short').expect(429);
    await new Promise((r) => setTimeout(r, 1_100));
    await http().get('/api/v1/rl-int/short').expect(200);
  });

  it('shares one window between concurrent requests (atomic counter)', async () => {
    const store = app.get<RateLimitApi.RateLimitStore>(api.RATE_LIMIT_STORE);
    const hits = await Promise.all(
      Array.from({ length: 20 }, () => store.hit('int-concurrency:k', 10_000)),
    );
    expect(hits.map((h) => h.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('never limits health probes', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await http().get('/api/v1/health/ready').expect(200);
      expect(res.headers['ratelimit-limit']).toBeUndefined();
    }
  });
});
