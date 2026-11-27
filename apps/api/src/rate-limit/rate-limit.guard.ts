import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
  SetMetadata,
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { RateLimitErrorDetails } from '@habit/shared-types';
import {
  SESSION_RESOLVER,
  checkRequestOrigin,
  isUnsafeMethod,
  routeAuthPolicy,
  type SessionResolver,
} from '../common/auth/index.js';
import { currentRequestContext } from '../common/request/request-context.js';
import type { Env } from '../config/env.js';
import { ApiException } from '../common/errors/api-exception.js';
import { OutageLogger } from '../queue/outage-logger.js';
import {
  RATE_LIMIT_CLASSES,
  resolvePolicy,
  type RateLimitClassName,
  type RateLimitPolicy,
} from './rate-limit.policies.js';
import { RATE_LIMIT_STORE, type RateLimitHit, type RateLimitStore } from './rate-limit.store.js';

const RATE_LIMIT_POLICY = 'habit:rate-limit:policy';
const RATE_LIMIT_SKIP = 'habit:rate-limit:skip';

/**
 * Counts the route (or every route of a controller) against a stricter class in addition to the
 * global `default` policy, e.g. `@RateLimit('auth')` on login. The request must fit both.
 */
export function RateLimit(
  policy: RateLimitClassName | RateLimitPolicy,
): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(RATE_LIMIT_POLICY, resolvePolicy(policy)));
}

/**
 * Exempts a route or controller from all rate limiting. Only for infrastructure endpoints polled
 * by trusted callers (liveness/readiness probes) — never for user-facing routes.
 */
export function SkipRateLimit(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(RATE_LIMIT_SKIP, true));
}

/**
 * The policies a route counts against, in order: `default` plus the route's (or controller's)
 * class, or none for `@SkipRateLimit()`. Shared by the guard and the OpenAPI generator (P1-06),
 * so the documented 429 matches what is enforced.
 */
export function routeRateLimitPolicies(
  reflector: Reflector,
  handler: ReturnType<ExecutionContext['getHandler']>,
  controller: ReturnType<ExecutionContext['getClass']>,
): RateLimitPolicy[] {
  const targets = [handler, controller];
  if (reflector.getAllAndOverride<boolean>(RATE_LIMIT_SKIP, targets)) return [];
  const routePolicy = reflector.getAllAndOverride<RateLimitPolicy | undefined>(
    RATE_LIMIT_POLICY,
    targets,
  );
  const policies: RateLimitPolicy[] = [RATE_LIMIT_CLASSES.default];
  if (routePolicy && routePolicy.name !== RATE_LIMIT_CLASSES.default.name) {
    policies.push(routePolicy);
  }
  return policies;
}

interface ClientRequest extends IncomingMessage {
  /** Client address as resolved by Express, honouring `trust proxy` (env `TRUST_PROXY`). */
  ip?: string;
}

/**
 * Stable identity of the client for a policy. Raw IP addresses are personal data, so they are not
 * written to Redis as such: the key holds a truncated SHA-256 of the identity. That is
 * pseudonymisation, not anonymisation (the IPv4 space is small enough to brute-force), which is
 * acceptable because the key lives only for one window (≤ 1 h) inside our own Redis (ADR-0011).
 * User ids are internal opaque ids already.
 */
export function clientKey(
  policy: RateLimitPolicy,
  ip: string | undefined,
  userId: string | undefined,
): string {
  const identity = policy.key === 'user-or-ip' && userId ? `u:${userId}` : `ip:${ip ?? 'unknown'}`;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  return `${policy.name}:${digest}`;
}

/** Outcome of one policy for one request. */
interface Verdict {
  policy: RateLimitPolicy;
  hit: RateLimitHit;
}

/**
 * Global guard (registered by `RateLimitModule` as the first `APP_GUARD`, so it runs before the
 * authentication guard — P2-03 — and limits unauthenticated floods too).
 *
 * - Applies `default` to every routed request, plus the route's class if it has one.
 * - Sets `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds) for the most
 *   constrained policy on every limited response (IETF draft "RateLimit header fields").
 * - Over the limit: 429 `RATE_LIMITED` in the standard error envelope (ADR-0009) with
 *   `Retry-After` (seconds) and `details.retryAfterSeconds`.
 * - Store unavailable: the policy's `onStoreFailure` — serve (`allow`, logged once per outage) or
 *   503 `SERVICE_UNAVAILABLE` (`deny`).
 *
 * Requests that match no route (404s) and CORS preflights never reach guards and are not counted.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimit');
  private readonly outage = new OutageLogger(this.logger, 'Rate-limit store');
  private readonly enabled: boolean;
  private readonly trustedOrigins: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    config: ConfigService<Env, true>,
    // Provided by the identity module (P2-03); absent in apps composed without it (tests).
    @Optional() @Inject(SESSION_RESOLVER) private readonly sessions?: SessionResolver,
  ) {
    this.enabled = config.get('RATE_LIMIT_ENABLED', { infer: true });
    this.trustedOrigins = new Set(config.get('CORS_ORIGINS', { infer: true }));
    if (!this.enabled) this.logger.warn('Rate limiting is DISABLED (RATE_LIMIT_ENABLED=false).');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled || context.getType() !== 'http') return true;
    const policies = routeRateLimitPolicies(
      this.reflector,
      context.getHandler(),
      context.getClass(),
    );
    if (policies.length === 0) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<ClientRequest>();
    const res = http.getResponse<ServerResponse>();
    const userId = await this.userIdFor(context, req, policies);

    const verdicts: Verdict[] = [];
    for (const policy of policies) {
      let hit: RateLimitHit;
      try {
        hit = await this.store.hit(clientKey(policy, req.ip, userId), policy.windowSeconds * 1000);
      } catch (error) {
        this.outage.error(error);
        if (policy.onStoreFailure === 'deny') {
          throw new ApiException(
            HttpStatus.SERVICE_UNAVAILABLE,
            'SERVICE_UNAVAILABLE',
            'Service temporarily unavailable.',
          );
        }
        continue;
      }
      this.outage.ready();
      verdicts.push({ policy, hit });
    }
    if (verdicts.length === 0) return true;

    // Report the policy closest to its limit (exceeded ones first, then fewest remaining).
    const tightest = verdicts.reduce((a, b) => (remaining(b) < remaining(a) ? b : a));
    const resetSeconds = Math.max(1, Math.ceil(tightest.hit.resetMs / 1000));
    res.setHeader('RateLimit-Limit', String(tightest.policy.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining(tightest))));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    const exceeded = verdicts.filter((v) => v.hit.count > v.policy.limit);
    if (exceeded.length === 0) return true;

    // Wait until every exceeded window has ended.
    const retryAfterSeconds = Math.max(
      ...exceeded.map((v) => Math.max(1, Math.ceil(v.hit.resetMs / 1000))),
    );
    res.setHeader('Retry-After', String(retryAfterSeconds));
    const details: RateLimitErrorDetails = {
      retryAfterSeconds,
      policy: exceeded.map((v) => v.policy.name).join(','),
    };
    // Debug only: the access line already records the 429; ids come from the log context.
    this.logger.debug({ msg: 'rate limit exceeded', policy: details.policy, retryAfterSeconds });
    throw new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      'RATE_LIMITED',
      'Too many requests.',
      details,
    );
  }

  /**
   * The user whose budget `user-or-ip` policies spend (P2-03, ADR-0019): the active session's
   * user on routes that look up a session (protected and `optional` ones), through the shared
   * per-request resolver, so the `AuthGuard` that runs next reuses the same lookup. `@Public()`
   * routes and anonymous requests are keyed by client address. A well-formed but unknown cookie
   * costs one indexed lookup and is then counted by address like any anonymous request. A
   * state-changing request from an untrusted origin (which the `AuthGuard` will reject as CSRF) is
   * counted by address without a lookup, so a foreign page cannot spend a victim's budget. A user
   * id already in the request context (set by middleware before guards) is honoured otherwise.
   */
  private async userIdFor(
    context: ExecutionContext,
    req: IncomingMessage,
    policies: readonly RateLimitPolicy[],
  ): Promise<string | undefined> {
    if (!policies.some((p) => p.key === 'user-or-ip')) return undefined;
    const fromContext = currentRequestContext()?.userId;
    if (!this.sessions) return fromContext;
    const auth = routeAuthPolicy(this.reflector, context.getHandler(), context.getClass());
    if (auth === 'public') return fromContext;
    if (isUnsafeMethod(req.method) && checkRequestOrigin(req, this.trustedOrigins)) {
      return fromContext;
    }
    return (await this.sessions.resolveRequest(req))?.userId ?? fromContext;
  }
}

function remaining(v: Verdict): number {
  return v.policy.limit - v.hit.count;
}
