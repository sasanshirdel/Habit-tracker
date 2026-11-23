// Platform rate limiting (backlog P1-08, ADR-0011).
export { RateLimit, RateLimitGuard, SkipRateLimit, clientKey } from './rate-limit.guard.js';
export { RateLimitModule } from './rate-limit.module.js';
export {
  RATE_LIMIT_CLASSES,
  resolvePolicy,
  type RateLimitClassName,
  type RateLimitPolicy,
} from './rate-limit.policies.js';
export {
  MemoryRateLimitStore,
  RATE_LIMIT_STORE,
  RATE_LIMIT_STORE_TIMEOUT_MS,
  RateLimitStoreUnavailableError,
  RedisRateLimitStore,
  type RateLimitHit,
  type RateLimitStore,
} from './rate-limit.store.js';
