import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HttpStatus,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  attachPrincipal,
  checkRequestOrigin,
  isUnsafeMethod,
  routeAuthPolicy,
} from '../../common/auth/index.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { setRequestUserId } from '../../common/request/request-context.js';
import type { Env } from '../../config/env.js';
import { CSRF_HEADER, csrfTokenFor, csrfTokenMatches } from './csrf-token.js';
import { RequestSessionResolver } from './request-session.resolver.js';
import { clearSessionCookie } from './session-cookie.js';

const CSRF_HEADER_LOWER = CSRF_HEADER.toLowerCase();

/**
 * Global customer authentication and CSRF guard (backlog P2-03, ADR-0019). Registered by
 * `IdentityModule` as an `APP_GUARD` after the rate limiter (AppModule imports `RateLimitModule`
 * first), so floods are limited before any session work.
 *
 * For every routed request:
 * 1. **Origin check** (unsafe methods, every route — public ones too): a foreign `Origin` or a
 *    cross-site `Sec-Fetch-Site` → 403 `CSRF_FAILED`.
 * 2. **Deny by default:** unless the route is `@Public()`, the `__Host-session` cookie must
 *    resolve to an active session (not revoked, within 30 d absolute / 7 d idle, account not
 *    deleted; `last_used_at` slides) → else 401 `UNAUTHENTICATED`, and a stale cookie is cleared.
 * 3. **CSRF token** (unsafe methods, whenever a session was resolved — protected routes and
 *    `@Public({ session: 'optional' })` ones): `X-CSRF-Token` must equal the session's token
 *    → else 403 `CSRF_FAILED`.
 * Then the principal is attached for `@CurrentUser()` and its id goes into the log context.
 *
 * Logs (info) only the rejection reason and method — never cookies, tokens or origins (the access
 * line of the same request carries the route and status).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger('Auth');
  private readonly trustedOrigins: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: RequestSessionResolver,
    config: ConfigService<Env, true>,
  ) {
    this.trustedOrigins = new Set(config.get('CORS_ORIGINS', { infer: true }));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const req = http.getRequest<IncomingMessage>();
    const res = http.getResponse<ServerResponse>();
    const policy = routeAuthPolicy(this.reflector, context.getHandler(), context.getClass());
    const unsafe = isUnsafeMethod(req.method);

    if (unsafe) {
      const rejection = checkRequestOrigin(req, this.trustedOrigins);
      if (rejection) this.csrfFailed(req, rejection);
    }
    if (policy === 'public') return true;

    const { presented, principal, token } = await this.sessions.resolution(req);
    if (!principal || token === undefined) {
      // A cookie that no longer opens a session is useless to the browser: remove it.
      if (presented) clearSessionCookie(res);
      if (policy === 'optional') return true;
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Not signed in.');
    }
    if (unsafe && !csrfTokenMatches(req.headers[CSRF_HEADER_LOWER], csrfTokenFor(token))) {
      this.csrfFailed(
        req,
        req.headers[CSRF_HEADER_LOWER] === undefined ? 'token-missing' : 'token-mismatch',
      );
    }
    attachPrincipal(req, principal);
    setRequestUserId(principal.userId);
    return true;
  }

  private csrfFailed(req: IncomingMessage, reason: string): never {
    this.logger.log({ msg: 'csrf check failed', reason, method: req.method });
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      'CSRF_FAILED',
      'Request rejected: missing or invalid CSRF protection.',
    );
  }
}
