import { describe, expect, it, vi } from 'vitest';
import { DatabaseHealthIndicator, type DatabasePinger } from './database.health.js';
import { errorCode } from './prisma.service.js';

function indicator(queryRaw: DatabasePinger['$queryRaw'], timeoutMs?: number) {
  const health = new DatabaseHealthIndicator({ $queryRaw: queryRaw });
  if (timeoutMs !== undefined) health.timeoutMs = timeoutMs;
  return health;
}

describe('DatabaseHealthIndicator', () => {
  it('is up when SELECT 1 succeeds', async () => {
    const query = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    await expect(indicator(query).check()).resolves.toBe('up');
    expect(query).toHaveBeenCalledOnce();
  });

  it('is down (and does not throw) when the query fails', async () => {
    const query = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );
    await expect(indicator(query).check()).resolves.toBe('down');
  });

  it('is down when the database does not answer within the timeout', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn().mockReturnValue(new Promise(() => {}));
      const result = indicator(query, 50).check();
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toBe('down');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('errorCode', () => {
  it('returns driver/system codes without the message', () => {
    expect(errorCode(Object.assign(new Error('password for user x'), { code: '28P01' }))).toBe(
      '28P01',
    );
  });

  it('falls back to the error name, then to unknown', () => {
    expect(errorCode(new TypeError('boom'))).toBe('TypeError');
    expect(errorCode('nope')).toBe('unknown');
  });
});
