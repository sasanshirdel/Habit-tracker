/**
 * Rate-limit policies (backlog P1-08, ADR-0011).
 *
 * Every request routed to a controller counts against the global `default` policy. A route can
 * additionally count against a stricter class with `@RateLimit('auth')` (both must allow the
 * request), or opt out entirely with `@SkipRateLimit()` (health probes only).
 *
 * Algorithm: fixed window per (policy, client). The first request opens a window of
 * `windowSeconds`; up to `limit` requests are allowed in it; the next one gets 429 with
 * `Retry-After` = seconds until the window ends. Counters are atomic in Redis, so the limit holds
 * across API instances.
 */
export interface RateLimitPolicy {
  /** Stable name; part of the Redis key, so renaming one resets its counters. `[a-z0-9-]`. */
  readonly name: string;
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
  /**
   * Whose budget a request spends:
   * - `ip`: the client address (pre-authentication endpoints: login, recovery, verification);
   * - `user-or-ip`: the authenticated user id once P2-03 sets it, else the client address — so
   *   users behind one NAT do not share a budget once signed in.
   */
  readonly key: 'ip' | 'user-or-ip';
  /**
   * When the counter store (Redis) is unavailable:
   * - `allow` (fail open): serve the request — a Redis outage must not take the whole API down;
   * - `deny` (fail closed): answer 503 `SERVICE_UNAVAILABLE` — for brute-force-sensitive routes,
   *   where serving without a limit is the bigger risk.
   */
  readonly onStoreFailure: 'allow' | 'deny';
}

/** The named classes routes choose from. Adjust numbers here (with a test), not per route. */
export const RATE_LIMIT_CLASSES = {
  /** Global baseline for every routed request. */
  default: {
    name: 'default',
    limit: 300,
    windowSeconds: 60,
    key: 'user-or-ip',
    onStoreFailure: 'allow',
  },
  /**
   * Credential and code endpoints (login, registration, password recovery, email verification,
   * MFA — Phase 2/10). Per client address; progressive per-account lockout comes on top in P2-02.
   */
  auth: {
    name: 'auth',
    limit: 10,
    windowSeconds: 300,
    key: 'ip',
    onStoreFailure: 'deny',
  },
  /** Costly operations (data export, AI requests, report generation). */
  expensive: {
    name: 'expensive',
    limit: 20,
    windowSeconds: 3_600,
    key: 'user-or-ip',
    onStoreFailure: 'allow',
  },
  /**
   * Account-wide data operations that need re-authentication or hand out all of a user's data:
   * data export and account deletion (P2-10, ADR-0025). Per user; fails closed, because serving
   * them without a limit (password guessing on deletion, bulk export by a stolen session) is the
   * bigger risk than refusing for the length of a Redis outage.
   */
  sensitive: {
    name: 'sensitive',
    limit: 10,
    windowSeconds: 3_600,
    key: 'user-or-ip',
    onStoreFailure: 'deny',
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitClassName = keyof typeof RATE_LIMIT_CLASSES;

const POLICY_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Resolves a class name or validates an inline policy (tests, rare one-off routes). */
export function resolvePolicy(policy: RateLimitClassName | RateLimitPolicy): RateLimitPolicy {
  if (typeof policy === 'string') {
    const named = RATE_LIMIT_CLASSES[policy] as RateLimitPolicy | undefined;
    if (!named) throw new Error(`Unknown rate-limit class "${policy}".`);
    return named;
  }
  if (!POLICY_NAME.test(policy.name) || policy.name.length > 32) {
    throw new Error(`Invalid rate-limit policy name "${policy.name}".`);
  }
  if (!Number.isInteger(policy.limit) || policy.limit < 1) {
    throw new Error(`Rate-limit policy "${policy.name}": limit must be a positive integer.`);
  }
  if (!Number.isInteger(policy.windowSeconds) || policy.windowSeconds < 1) {
    throw new Error(
      `Rate-limit policy "${policy.name}": windowSeconds must be a positive integer.`,
    );
  }
  return policy;
}
