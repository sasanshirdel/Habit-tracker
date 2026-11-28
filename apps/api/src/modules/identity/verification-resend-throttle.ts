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
 * Per-subject limits on emails a request can trigger: a cooldown between two sends plus an hourly
 * cap, in Redis (fixed hour window started by the first send). Used for "send me a new
 * verification link" (backlog P2-04, ADR-0021; keyed by the opaque user id) and, since P2-05
 * (ADR-0022), for password-reset requests (keyed by a truncated SHA-256 of the submitted address).
 * A refused request does not count.
 */
export interface EmailSendLimits {
  /** Policy name: part of the Redis key and `details.policy` of a 429. */
  readonly policy: string;
  readonly cooldownMs: number;
  readonly maxPerHour: number;
}

export interface ResendThrottleStore {
  /** Takes one slot; returns 0 when allowed, else the milliseconds until the next one. */
  take(key: string, limits: EmailSendLimits): Promise<number>;
}

/** The verification resend limits (P2-04): 1/min and 5/h per account. */
export const VERIFICATION_RESEND_LIMITS: EmailSendLimits = {
  policy: VERIFICATION_EMAIL_POLICY_NAME,
  cooldownMs: EMAIL_VERIFICATION_POLICY.resendCooldownSeconds * 1000,
  maxPerHour: EMAIL_VERIFICATION_POLICY.resendMaxPerHour,
};

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
    this.prefix = config.get('RATE_LIMIT_PREFIX', { infer: true });
  }

  async take(key: string, limits: EmailSendLimits): Promise<number> {
    if (!this.redis.isReady) throw new ResendThrottleUnavailableError('not connected');
    const prefix = `${this.prefix}:${limits.policy}`;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ResendThrottleUnavailableError('timeout')), TIMEOUT_MS);
    });
    try {
      const reply = await Promise.race([
        this.redis.client.eval(
          TAKE_SCRIPT,
          2,
          `${prefix}:cooldown:${key}`,
          `${prefix}:hour:${key}`,
          String(limits.cooldownMs),
          String(HOUR_MS),
          String(limits.maxPerHour),
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

  async take(key: string, limits: EmailSendLimits): Promise<number> {
    const now = this.now();
    const id = `${limits.policy}:${key}`;
    let entry = this.entries.get(id);
    if (!entry || entry.hourEnds <= now) entry = { cooldownUntil: 0, count: 0, hourEnds: 0 };
    if (entry.cooldownUntil > now) return entry.cooldownUntil - now;
    if (entry.count >= limits.maxPerHour) return entry.hourEnds - now;
    if (entry.count === 0) entry.hourEnds = now + HOUR_MS;
    entry.count += 1;
    entry.cooldownUntil = now + limits.cooldownMs;
    this.entries.set(id, entry);
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
      waitMs = await this.store.take(userId, VERIFICATION_RESEND_LIMITS);
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
