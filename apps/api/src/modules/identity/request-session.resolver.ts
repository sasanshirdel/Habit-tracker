import type { IncomingMessage } from 'node:http';
import { Injectable } from '@nestjs/common';
import type { RequestPrincipal, SessionResolver } from '../../common/auth/index.js';
import { readSessionCookie } from './session-cookie.js';
import { SessionService } from './session.service.js';

interface Resolution {
  /** Whether the request presented a session cookie at all. */
  readonly presented: boolean;
  readonly principal: RequestPrincipal | null;
  /** The presented token, kept only in memory for the CSRF check of this request. */
  readonly token: string | undefined;
}

/**
 * Resolves the `__Host-session` cookie of a request once (backlog P2-03): the rate limiter and
 * the `AuthGuard` share the result, so a request costs at most one session lookup. Idle/absolute
 * expiry, revocation, deleted accounts and the sliding `last_used_at` refresh are
 * `SessionService.resolve`'s rules (ADR-0018).
 */
@Injectable()
export class RequestSessionResolver implements SessionResolver {
  private readonly cache = new WeakMap<IncomingMessage, Promise<Resolution>>();

  constructor(private readonly sessions: SessionService) {}

  async resolveRequest(req: IncomingMessage): Promise<RequestPrincipal | null> {
    return (await this.resolution(req)).principal;
  }

  /** Full resolution, including whether a cookie was presented and its token (identity only). */
  resolution(req: IncomingMessage): Promise<Resolution> {
    let pending = this.cache.get(req);
    if (!pending) {
      pending = this.load(req);
      this.cache.set(req, pending);
    }
    return pending;
  }

  private async load(req: IncomingMessage): Promise<Resolution> {
    const token = readSessionCookie(req);
    if (token === undefined) return { presented: false, principal: null, token: undefined };
    const session = await this.sessions.resolve(token);
    return {
      presented: true,
      principal: session
        ? {
            userId: session.userId,
            sessionId: session.sessionId,
            emailVerified: session.emailVerified,
          }
        : null,
      token: session ? token : undefined,
    };
  }
}
