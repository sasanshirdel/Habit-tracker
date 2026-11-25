import { describe, expect, it, vi } from 'vitest';
import { OutageLogger } from './outage-logger.js';
import { redisRetryDelay } from './redis-connection.service.js';
import { RedisHealthIndicator } from './redis.health.js';

function indicator(isReady: boolean, ping: () => Promise<string>, timeoutMs?: number) {
  const health = new RedisHealthIndicator({ isReady, client: { ping } });
  if (timeoutMs !== undefined) health.timeoutMs = timeoutMs;
  return health;
}

describe('RedisHealthIndicator', () => {
  it('is up when PING answers PONG', async () => {
    const ping = vi.fn().mockResolvedValue('PONG');
    await expect(indicator(true, ping).check()).resolves.toBe('up');
    expect(ping).toHaveBeenCalledOnce();
  });

  it('is down without a round-trip when the connection is not established', async () => {
    const ping = vi.fn();
    await expect(indicator(false, ping).check()).resolves.toBe('down');
    expect(ping).not.toHaveBeenCalled();
  });

  it('is down (and does not throw) when PING fails', async () => {
    const ping = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    await expect(indicator(true, ping).check()).resolves.toBe('down');
  });

  it('is down when Redis does not answer within the timeout', async () => {
    vi.useFakeTimers();
    try {
      const result = indicator(true, () => new Promise(() => {}), 50).check();
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toBe('down');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('redisRetryDelay', () => {
  it('backs off linearly and caps at 2 s, never giving up', () => {
    expect([1, 2, 5, 10, 1_000].map(redisRetryDelay)).toEqual([200, 400, 1_000, 2_000, 2_000]);
  });
});

describe('OutageLogger', () => {
  it('logs an outage once with the error code only, then the recovery once', () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const outage = new OutageLogger(logger, 'Redis');
    const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6379'), {
      code: 'ECONNREFUSED',
    });
    outage.error(error);
    outage.error(error);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toContain('ECONNREFUSED');
    expect(logger.warn.mock.calls[0]?.[0]).not.toContain('10.0.0.5');
    outage.ready();
    outage.ready();
    expect(logger.log).toHaveBeenCalledOnce();
    expect(outage.isDown).toBe(false);
  });
});
