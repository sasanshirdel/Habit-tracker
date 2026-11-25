import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RATE_LIMIT_STORE, RedisRateLimitStore } from './rate-limit.store.js';

/**
 * Platform rate limiting (backlog P1-08, ADR-0011): a global guard backed by Redis counters on the
 * shared connection from `QueueModule`. Import it in `AppModule` before any module that registers
 * an authentication guard, so the limiter runs first. Tests replace `RATE_LIMIT_STORE` with a
 * `MemoryRateLimitStore` via `Test.createTestingModule().overrideProvider(...)`.
 */
@Module({
  providers: [
    { provide: RATE_LIMIT_STORE, useClass: RedisRateLimitStore },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class RateLimitModule {}
