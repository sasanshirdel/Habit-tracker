import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../../common/errors/api-exception.js';
import type { Env } from '../../config/env.js';
import { OutageLogger } from '../../queue/outage-logger.js';
import { RedisConnection } from '../../queue/redis-connection.service.js';

/**
 * Per-account brute-force protection for sign-in (backlog P2-02, ADR-0018), on top of the
 * per-address `auth` rate limit (ADR-0011): progressive lockout keyed by the **submitted email
 * address**, whether or not an account exists — so a lockout says nothing about which addresses
 * are registered.
 *
 * - Every failed sign-in counts against the address; the count is forgotten
 *   {@link LOGIN_LOCKOUT_POLICY.failureMemorySeconds} after the last failure, or at the next
 *   successful sign-in.
 * - From the {@link LOGIN_LOCKOUT_POLICY.threshold}-th consecutive failure on, the address is
 *   locked for 1 min, then 2, 4, 8, capped at 15 min per further failure (the attempt that
 *   triggers the lock still gets its normal 401). While locked every attempt — right password or
 *   not — is refused with 429 `RATE_LIMITED` (`policy: "login-account"`) without checking the
 *   password.
 * - Counter keys contain a truncated SHA-256 of the normalised address, never the address itself
 *   (pseudonymised: fine for a key that lives ≤ 1 h in our own Redis, like the address hashes of
 *   ADR-0011).
 * - Fails **closed**: without Redis, sign-in answers 503 `SERVICE_UNAVAILABLE` (it is behind the
 *   `auth` class, which fails closed too).
 *
 * A lockout is a nuisance an attacker can cause for a known address (at most 15 min at a time,
 * while the per-address `auth` limit slows them down); it never blocks password recovery (P2-05).
 */
export const LOGIN_LOCKOUT_POLICY = {
  /** Consecutive failures before the first lock. */
  threshold: 5,
  /** First lock; doubles with each further failure. */
  baseLockSeconds: 60,
  maxLockSeconds: 900,
  /** Failures are remembered this long after the last one. */
  failureMemorySeconds: 3_600,
} as const;

/** Name reported in `details.policy` of the 429. */
export const LOGIN_LOCKOUT_POLICY_NAME = 'login-account';

export interface LoginThrottleStore {
  /** Milliseconds the key stays locked (0 when not locked). */
  lockedForMs(key: string): Promise<number>;
  /** Records one failure; returns the consecutive count and the lock it started (0 if none). */
  recordFailure(key: string): Promise<{ failures: number; lockMs: number }>;
  /** Forgets failures and any lock. */
  reset(key: string): Promise<void>;
}

export const LOGIN_THROTTLE_STORE = Symbol('LOGIN_THROTTLE_STORE');

/** Upper bound for one Redis round-trip (same as the rate-limit store). */
export const LOGIN_THROTTLE_TIMEOUT_MS = 250;

/**
 * Lock duration for the n-th consecutive failure (0 below the threshold). Shared by both stores,
 * and mirrored by {@link FAILURE_SCRIPT} for Redis.
 */
export function lockMsForFailures(failures: number): number {
  const { threshold, baseLockSeconds, maxLockSeconds } = LOGIN_LOCKOUT_POLICY;
  if (failures < threshold) return 0;
  const seconds = Math.min(baseLockSeconds * 2 ** (failures - threshold), maxLockSeconds);
  return seconds * 1000;
}

// KEYS[1] failure counter, KEYS[2] lock. ARGV: failure memory ms, threshold, base lock ms, max lock ms.
const FAILURE_SCRIPT = `
local failures = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
local threshold = tonumber(ARGV[2])
if failures < threshold then
  return {failures, 0}
end
local lock = tonumber(ARGV[3]) * (2 ^ (failures - threshold))
local max = tonumber(ARGV[4])
if lock > max then lock = max end
lock = math.floor(lock)
redis.call('SET', KEYS[2], '1', 'PX', lock)
return {failures, lock}
`;

class LoginThrottleUnavailableError extends Error {
  override readonly name = 'LoginThrottleUnavailableError';
  readonly code = 'LOGIN_THROTTLE_UNAVAILABLE';
}

/** Counters in Redis on the shared connection, under `RATE_LIMIT_PREFIX`. */
@Injectable()
export class RedisLoginThrottleStore implements LoginThrottleStore {
  private readonly prefix: string;
  timeoutMs = LOGIN_THROTTLE_TIMEOUT_MS;

  constructor(
    private readonly redis: RedisConnection,
    config: ConfigService<Env, true>,
  ) {
    this.prefix = `${config.get('RATE_LIMIT_PREFIX', { infer: true })}:${LOGIN_LOCKOUT_POLICY_NAME}`;
  }

  async lockedForMs(key: string): Promise<number> {
    const ttl = await this.call(() => this.redis.client.pttl(`${this.prefix}:lock:${key}`));
    if (typeof ttl !== 'number') throw new LoginThrottleUnavailableError('bad reply');
    return Math.max(0, ttl);
  }

  async recordFailure(key: string): Promise<{ failures: number; lockMs: number }> {
    const { failureMemorySeconds, threshold, baseLockSeconds, maxLockSeconds } =
      LOGIN_LOCKOUT_POLICY;
    const reply = await this.call(() =>
      this.redis.client.eval(
        FAILURE_SCRIPT,
        2,
        `${this.prefix}:fail:${key}`,
        `${this.prefix}:lock:${key}`,
        String(failureMemorySeconds * 1000),
        String(threshold),
        String(baseLockSeconds * 1000),
        String(maxLockSeconds * 1000),
      ),
    );
    if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'number') {
      throw new LoginThrottleUnavailableError('bad reply');
    }
    return { failures: reply[0], lockMs: reply[1] };
  }

  async reset(key: string): Promise<void> {
    await this.call(() =>
      this.redis.client.del(`${this.prefix}:fail:${key}`, `${this.prefix}:lock:${key}`),
    );
  }

  private async call<T>(command: () => Promise<T>): Promise<T> {
    if (!this.redis.isReady) throw new LoginThrottleUnavailableError('not connected');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new LoginThrottleUnavailableError('timeout')),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([command(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Process-local store with the same semantics, for unit/e2e tests without Redis. */
export class MemoryLoginThrottleStore implements LoginThrottleStore {
  private readonly entries = new Map<
    string,
    { failures: number; forgetAt: number; lockedUntil: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  async lockedForMs(key: string): Promise<number> {
    const entry = this.entries.get(key);
    return entry ? Math.max(0, entry.lockedUntil - this.now()) : 0;
  }

  async recordFailure(key: string): Promise<{ failures: number; lockMs: number }> {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.forgetAt <= now) entry = { failures: 0, forgetAt: 0, lockedUntil: 0 };
    entry.failures += 1;
    entry.forgetAt = now + LOGIN_LOCKOUT_POLICY.failureMemorySeconds * 1000;
    const lockMs = lockMsForFailures(entry.failures);
    if (lockMs > 0) entry.lockedUntil = now + lockMs;
    this.entries.set(key, entry);
    return { failures: entry.failures, lockMs };
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/** Thrown when the address is locked; carries the wait for `Retry-After`. */
export class LoginLockedError extends ApiException {
  constructor(readonly retryAfterSeconds: number) {
    super(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many requests.', {
      retryAfterSeconds,
      policy: LOGIN_LOCKOUT_POLICY_NAME,
    });
  }
}

/** Applies {@link LOGIN_LOCKOUT_POLICY} for an email address. */
@Injectable()
export class LoginThrottle {
  private readonly logger = new Logger('LoginThrottle');
  private readonly outage = new OutageLogger(this.logger, 'Login throttle store');

  constructor(@Inject(LOGIN_THROTTLE_STORE) private readonly store: LoginThrottleStore) {}

  /** Throws {@link LoginLockedError} while the address is locked. */
  async assertNotLocked(email: string): Promise<void> {
    const ms = await this.guard(() => this.store.lockedForMs(keyFor(email)));
    if (ms > 0) throw new LoginLockedError(Math.max(1, Math.ceil(ms / 1000)));
  }

  async recordFailure(email: string): Promise<void> {
    const { lockMs } = await this.guard(() => this.store.recordFailure(keyFor(email)));
    // No address or key in the line: the request id ties it to the access log.
    if (lockMs > 0) this.logger.warn({ msg: 'sign-in locked', lockSeconds: lockMs / 1000 });
  }

  async recordSuccess(email: string): Promise<void> {
    await this.guard(() => this.store.reset(keyFor(email)));
  }

  private async guard<T>(op: () => Promise<T>): Promise<T> {
    try {
      const result = await op();
      this.outage.ready();
      return result;
    } catch (error) {
      this.outage.error(error);
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'SERVICE_UNAVAILABLE',
        'Service temporarily unavailable.',
      );
    }
  }
}

/** Counter key for a normalised address: truncated SHA-256, never the address itself. */
export function keyFor(email: string): string {
  return createHash('sha256').update(`email:${email}`).digest('hex').slice(0, 32);
}
