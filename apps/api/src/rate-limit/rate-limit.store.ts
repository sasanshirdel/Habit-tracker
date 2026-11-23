import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { RedisConnection } from '../queue/redis-connection.service.js';

/** Result of counting one request in a window. */
export interface RateLimitHit {
  /** Requests counted in the current window, this one included. */
  count: number;
  /** Milliseconds until the window ends and the counter resets. */
  resetMs: number;
}

/** Where counters live. Redis in every running process; an in-memory store for unit tests only. */
export interface RateLimitStore {
  /** Atomically counts one request for `key` in a fixed window of `windowMs`. */
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

/** Injection token for the store (`RedisRateLimitStore` by default). */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

/** The store could not answer; the guard applies the policy's `onStoreFailure`. */
export class RateLimitStoreUnavailableError extends Error {
  override readonly name = 'RateLimitStoreUnavailableError';
  readonly code = 'RATE_LIMIT_STORE_UNAVAILABLE';

  constructor(reason: 'not_connected' | 'timeout' | 'bad_reply') {
    super(`Rate-limit store is unavailable (${reason}).`);
  }
}

/**
 * Upper bound for one counter round-trip. A slow Redis must not add latency to every request:
 * after this the guard treats the store as unavailable for that request.
 */
export const RATE_LIMIT_STORE_TIMEOUT_MS = 250;

/**
 * INCR + expiry in one atomic step. The window starts with the first request (PEXPIRE only when
 * the key is new); a key that somehow lost its TTL gets it back, so a counter can never live
 * forever and lock a client out.
 */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

/**
 * Redis-backed counters on the process's shared connection (`RedisConnection`, P1-03), under
 * `RATE_LIMIT_PREFIX`. Keys never contain raw client data: the guard passes hashed identities.
 * Fails fast (not connected) or after {@link RATE_LIMIT_STORE_TIMEOUT_MS}; never queues requests
 * behind a reconnecting client.
 */
@Injectable()
export class RedisRateLimitStore implements RateLimitStore {
  private readonly prefix: string;
  timeoutMs = RATE_LIMIT_STORE_TIMEOUT_MS;

  constructor(
    private readonly redis: RedisConnection,
    config: ConfigService<Env, true>,
  ) {
    this.prefix = config.get('RATE_LIMIT_PREFIX', { infer: true });
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    if (!this.redis.isReady) throw new RateLimitStoreUnavailableError('not_connected');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RateLimitStoreUnavailableError('timeout')),
        this.timeoutMs,
      );
    });
    try {
      const reply = await Promise.race([
        this.redis.client.eval(HIT_SCRIPT, 1, `${this.prefix}:${key}`, String(windowMs)),
        timeout,
      ]);
      if (
        !Array.isArray(reply) ||
        reply.length !== 2 ||
        typeof reply[0] !== 'number' ||
        typeof reply[1] !== 'number'
      ) {
        throw new RateLimitStoreUnavailableError('bad_reply');
      }
      return { count: reply[0], resetMs: Math.max(0, reply[1]) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Process-local counters with the same fixed-window semantics, for unit/e2e tests that run
 * without Redis. Not safe across instances — never registered by the app itself.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return { count: window.count, resetMs: window.resetAt - now };
  }

  reset(): void {
    this.windows.clear();
  }
}
