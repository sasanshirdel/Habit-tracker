import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { BaseEnv } from '../config/env.js';
import { OutageLogger } from './outage-logger.js';

/** Upper bound for opening a Redis connection. */
export const REDIS_CONNECT_TIMEOUT_MS = 5_000;

/** Reconnect delay: 200 ms, 400 ms, … capped at 2 s; never gives up (ioredis keeps retrying). */
export function redisRetryDelay(attempt: number): number {
  return Math.min(attempt * 200, 2_000);
}

/**
 * The process's shared Redis connection (ioredis), used by queue producers and the readiness
 * check. BullMQ workers open their own connections (they need blocking commands).
 *
 * - The URL comes only from validated env (`REDIS_URL`) and is never logged.
 * - Startup does not require Redis: while it is down the instance is *not ready*
 *   (`/api/v1/health/ready` → 503) and enqueueing fails fast with `QUEUE_UNAVAILABLE`; ioredis
 *   reconnects in the background.
 * - Closed last (`onApplicationShutdown`), after the queues using it (`onModuleDestroy`).
 */
@Injectable()
export class RedisConnection implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisConnection.name);
  private readonly outage = new OutageLogger(this.logger, 'Redis');
  readonly client: Redis;

  constructor(config: ConfigService<BaseEnv, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      // Producer commands fail after a few retries instead of queueing forever.
      maxRetriesPerRequest: 2,
      retryStrategy: redisRetryDelay,
    });
    this.client.on('error', (error: unknown) => this.outage.error(error));
    this.client.on('ready', () => this.outage.ready());
  }

  get isReady(): boolean {
    return this.client.status === 'ready';
  }

  /** Forwards errors from BullMQ objects sharing this connection (same outage, logged once). */
  reportError(error: unknown): void {
    this.outage.error(error);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'ready') {
      try {
        await this.client.quit();
        return;
      } catch {
        // fall through to a hard disconnect
      }
    }
    // Not connected (or quit failed): stop the reconnect loop immediately.
    this.client.disconnect();
  }
}
