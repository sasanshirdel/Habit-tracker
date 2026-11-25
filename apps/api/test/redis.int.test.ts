import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { RespClient } from './integration/redis-resp.js';

// Integration: real Redis service (docker-compose locally, service container in CI — backlog
// P1-02). Verifies the properties BullMQ (P1-03) depends on. All keys live under the per-run
// prefix provided by global setup, which removes them afterwards.
const redisUrl = inject('integrationRedisUrl');
const prefix = inject('integrationRedisKeyPrefix');

/** Parses the `key:value` lines of an INFO section. */
function parseInfo(info: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of info.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

describe('Redis service (real Redis)', () => {
  let redis: RespClient;

  beforeAll(async () => {
    redis = await RespClient.connect(redisUrl);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it('answers PING', async () => {
    expect(await redis.command(['PING'])).toBe('PONG');
  });

  it('runs a Redis version BullMQ supports (>= 6.2; we pin 8.x)', async () => {
    const info = parseInfo(String(await redis.command(['INFO', 'server'])));
    const [major = 0, minor = 0] = (info.redis_version ?? '0.0').split('.').map(Number);
    expect(major * 100 + minor, `redis_version=${info.redis_version}`).toBeGreaterThanOrEqual(602);
    expect(major).toBeGreaterThanOrEqual(8);
  });

  it('uses maxmemory-policy noeviction (required so BullMQ keys are never evicted)', async () => {
    const reply = await redis.command(['CONFIG', 'GET', 'maxmemory-policy']);
    expect(reply).toEqual(['maxmemory-policy', 'noeviction']);
  });

  it('round-trips a value with an expiry under the run prefix', async () => {
    const key = `${prefix}roundtrip`;
    expect(await redis.command(['SET', key, 'سلام hello', 'PX', '60000'])).toBe('OK');
    expect(await redis.command(['GET', key])).toBe('سلام hello');
    const ttl = Number(await redis.command(['PTTL', key]));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(await redis.command(['DEL', key])).toBe(1);
    expect(await redis.command(['GET', key])).toBeNull();
  });

  it('leaves keys under the run prefix for global teardown to remove', async () => {
    // Deliberately not deleted here: global teardown SCAN-deletes `${prefix}*` (checked in CI by
    // the "no leftover integration keys" step).
    expect(await redis.command(['SET', `${prefix}left-for-teardown`, '1'])).toBe('OK');
  });

  it('surfaces Redis error replies as rejections', async () => {
    await expect(redis.command(['NOT_A_REAL_COMMAND'])).rejects.toThrow(/unknown command/i);
    // The connection stays usable after an error reply.
    expect(await redis.command(['PING'])).toBe('PONG');
  });
});
