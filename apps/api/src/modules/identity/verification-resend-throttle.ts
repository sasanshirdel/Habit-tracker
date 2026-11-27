import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../../common/errors/api-exception.js';
import type { Env } from '../../config/env.js';
import { OutageLogger } from '../../queue/outage-logger.js';
import { RedisConnection } from '../../queue/redis-connection.service.js';
import {
  EMAIL_VERIFICATION_POLICY,
  VERIFICATION_EMAIL_POLICY_NAME,
} from './email-verification.policy.js';

/**
 * Per-account limit on "send me a new verification link" (backlog P2-04, ADR-0021), on top of the
 * per-address `auth` class: one request per {@link EMAIL_VERIFICATION_POLICY.resendCooldownSeconds}
 * and at most {@link EMAIL_VERIFICATION_POLICY.resendMaxPerHour} per hour, keyed by the opaque user
 * id (the route is signed-in only, so there is nothing to enumerate). Fails closed (503) without
 * Redis, like the other auth limits.
 */
export interface ResendThrottleStore {
  /** Takes one slot; returns 0 when allowed, else the milliseconds until the next one. */
  take(key: string): Promise<number>;
}

export const RESEND_THROTTLE_STORE = Symbol('RESEND_THROTTLE_STORE');
const TIMEOUT_MS = 250;
const HOUR_MS = 3_600_000;

// KEYS[1] cooldown, KEYS[2] hourly counter. ARGV: cooldown ms, hour ms, hourly max.
// Returns the wait in ms (0 = allowed). A refused request does not count.
const TAKE_SCRIPT = `
local cooldown = redis.call('PTTL', KEYS[1])
if cooldown > 0 then return cooldown end
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= tonumber(ARGV[3]) then
  local ttl = redis.call('PTTL', KEYS[2])
  if ttl > 0 then return ttl end
end
local n = redis.call('INCR', KEYS[2])
if n == 1 or redis.call('PTTL', KEYS[2]) < 0 then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
return 0
`;

class ResendThrottleUnavailableError extends Error {
  override readonly name = 'ResendThrottleUnavailableError';
}

@Injectable()
export class RedisResendThrottleStore implements ResendThrottleStore {
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisConnection,
    config: ConfigService<Env, true>,
  ) {
    this.prefix = `${config.get('RATE_LIMIT_PREFIX', { infer: true })}:${VERIFICATION_EMAIL_POLICY_NAME}`;
  }

  async take(key: string): Promise<number> {
    if (!this.redis.isReady) throw new ResendThrottleUnavailableError('not connected');
    const { resendCooldownSeconds, resendMaxPerHour } = EMAIL_VERIFICATION_POLICY;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ResendThrottleUnavailableError('timeout')), TIMEOUT_MS);
    });
    try {
      const reply = await Promise.race([
        this.redis.client.eval(
          TAKE_SCRIPT,
          2,
          `${this.prefix}:cooldown:${key}`,
          `${this.prefix}:hour:${key}`,
          String(resendCooldownSeconds * 1000),
          String(HOUR_MS),
          String(resendMaxPerHour),
        ),
        timeout,
      ]);
      if (typeof reply !== 'number') throw new ResendThrottleUnavailableError('bad reply');
      return reply;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Same semantics in process memory, for tests without Redis. */
export class MemoryResendThrottleStore implements ResendThrottleStore {
  private readonly entries = new Map<
    string,
    { cooldownUntil: number; count: number; hourEnds: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  async take(key: string): Promise<number> {
    const now = this.now();
    const { resendCooldownSeconds, resendMaxPerHour } = EMAIL_VERIFICATION_POLICY;
    let entry = this.entries.get(key);
    if (!entry || entry.hourEnds <= now) entry = { cooldownUntil: 0, count: 0, hourEnds: 0 };
    if (entry.cooldownUntil > now) return entry.cooldownUntil - now;
    if (entry.count >= resendMaxPerHour) return entry.hourEnds - now;
    if (entry.count === 0) entry.hourEnds = now + HOUR_MS;
    entry.count += 1;
    entry.cooldownUntil = now + resendCooldownSeconds * 1000;
    this.entries.set(key, entry);
    return 0;
  }
}

/** 429 for a resend that came too soon or too often; carries the wait for `Retry-After`. */
export class ResendThrottledError extends ApiException {
  constructor(readonly retryAfterSeconds: number) {
    super(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many requests.', {
      retryAfterSeconds,
      policy: VERIFICATION_EMAIL_POLICY_NAME,
    });
  }
}

@Injectable()
export class VerificationResendThrottle {
  private readonly outage = new OutageLogger(new Logger('VerificationResend'), 'Resend throttle');

  constructor(@Inject(RESEND_THROTTLE_STORE) private readonly store: ResendThrottleStore) {}

  /** Takes a slot for `userId`, or throws {@link ResendThrottledError} / 503. */
  async take(userId: string): Promise<void> {
    let waitMs: number;
    try {
      waitMs = await this.store.take(userId);
      this.outage.ready();
    } catch (error) {
      this.outage.error(error);
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'SERVICE_UNAVAILABLE',
        'Service temporarily unavailable.',
      );
    }
    if (waitMs > 0) throw new ResendThrottledError(Math.max(1, Math.ceil(waitMs / 1000)));
  }
}
