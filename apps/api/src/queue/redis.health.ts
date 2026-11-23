import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DependencyStatus } from '@habit/shared-types';
import { errorCode } from '../database/prisma.service.js';
import { RedisConnection } from './redis-connection.service.js';

/** How long a readiness probe waits for Redis before reporting it down. */
export const REDIS_PING_TIMEOUT_MS = 2_000;

/** Minimal contract the readiness check needs, so it can be unit-tested without Redis. */
export interface RedisPinger {
  readonly isReady: boolean;
  readonly client: { ping(): Promise<string> };
}

/**
 * Redis health indicator: `PING` bounded by a timeout. Never throws and never returns driver
 * error details. A connection that is not established is reported down without a round-trip.
 */
@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);
  /** Overridable in tests; production uses the default. */
  timeoutMs = REDIS_PING_TIMEOUT_MS;

  constructor(@Inject(RedisConnection) private readonly redis: RedisPinger) {}

  async check(): Promise<DependencyStatus> {
    if (!this.redis.isReady) return 'down';
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RedisPingTimeoutError()), this.timeoutMs);
    });
    try {
      const reply = await Promise.race([this.redis.client.ping(), timeout]);
      return reply === 'PONG' ? 'up' : 'down';
    } catch (error) {
      this.logger.warn(`Redis readiness check failed (${errorCode(error)}).`);
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}

class RedisPingTimeoutError extends Error {
  override readonly name = 'RedisPingTimeout';
}
