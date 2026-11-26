import type { IncomingMessage } from 'node:http';
import {
  HttpStatus,
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ApiException } from '../errors/api-exception.js';

/**
 * Platform side of authentication (backlog P2-03, ADR-0019). Every route is **protected by
 * default**: the global `AuthGuard` (identity module) answers 401 `UNAUTHENTICATED` unless the
 * request carries an active customer session. A route opts out only with an explicit
 * {@link Public} marker, which a route-enumeration test keeps in an allow-list.
 *
 * These decorators live in the platform (`common/`) so platform controllers such as health can
 * use them without importing a feature module (ADR-0006, ADR-0016); the identity module provides
 * the implementation behind {@link SESSION_RESOLVER}.
 */

export const AUTH_POLICY_METADATA = 'habit:auth:policy';

/**
 * - `required` (default, no decorator): an active session or 401;
 * - `optional`: `@Public({ session: 'optional' })` — served without a session, but a presented
 *   session is resolved (and then CSRF-checked like a protected route), e.g. sign-out;
 * - `public`: `@Public()` — no session is looked up at all (health, register, sign-in).
 */
export type RouteAuthPolicy = 'required' | 'optional' | 'public';

export interface PublicOptions {
  /** `'optional'`: resolve a session when one is presented (see {@link RouteAuthPolicy}). */
  session?: 'optional';
}

/**
 * Marks a route or a whole controller as reachable without signing in. Every use is reviewed:
 * `test/route-guards.e2e.test.ts` lists the public routes and fails when one is added or removed
 * without updating that list.
 */
export function Public(options: PublicOptions = {}): MethodDecorator & ClassDecorator {
  const policy: RouteAuthPolicy = options.session === 'optional' ? 'optional' : 'public';
  return SetMetadata(AUTH_POLICY_METADATA, policy);
}

type Handler = ReturnType<ExecutionContext['getHandler']>;
type Controller = ReturnType<ExecutionContext['getClass']>;

/** The route's policy; the handler's marker wins over the controller's; unmarked → `required`. */
export function routeAuthPolicy(
  reflector: Reflector,
  handler: Handler,
  controller: Controller,
): RouteAuthPolicy {
  return (
    reflector.getAllAndOverride<RouteAuthPolicy | undefined>(AUTH_POLICY_METADATA, [
      handler,
      controller,
    ]) ?? 'required'
  );
}

/** The signed-in customer of a request. Opaque internal ids only — no email, no token. */
export interface RequestPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  /** Whether the account's email address is verified (P2-04), as of this request. */
  readonly emailVerified: boolean;
}

export const VERIFIED_EMAIL_METADATA = 'habit:auth:verified-email';

/**
 * Restricts a protected route to accounts with a **verified email address** (backlog P2-04,
 * ADR-0021): a signed-in user whose address is not verified gets 403 `EMAIL_NOT_VERIFIED`
 * (checked by the global `AuthGuard` after authentication and CSRF). Unverified users can sign in
 * and use their own data; features that reach other people or rely on the address — changing the
 * address, accountability invitations, email notifications, billing — use this marker when they
 * are built. Meaningless on `@Public()` routes (no principal), so the guard ignores it there.
 */
export function RequireVerifiedEmail(): MethodDecorator & ClassDecorator {
  return SetMetadata(VERIFIED_EMAIL_METADATA, true);
}

/** Whether the route (handler or controller) carries {@link RequireVerifiedEmail}. */
export function requiresVerifiedEmail(
  reflector: Reflector,
  handler: Handler,
  controller: Controller,
): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(VERIFIED_EMAIL_METADATA, [
      handler,
      controller,
    ]) === true
  );
}

/**
 * Resolves (and caches per request) the active session a request presents. Provided by the
 * identity module under this token; the rate limiter uses it to key `user-or-ip` budgets by user,
 * the `AuthGuard` to authenticate. Resolution happens at most once per request.
 */
export const SESSION_RESOLVER = Symbol('SESSION_RESOLVER');

export interface SessionResolver {
  /** The request's active session, or `null` (no cookie, malformed, unknown, expired, revoked). */
  resolveRequest(req: IncomingMessage): Promise<RequestPrincipal | null>;
}

const principals = new WeakMap<IncomingMessage, RequestPrincipal>();

/** Records the authenticated principal on the request (called by the `AuthGuard` only). */
export function attachPrincipal(req: IncomingMessage, principal: RequestPrincipal): void {
  principals.set(req, principal);
}

/** The principal the `AuthGuard` attached, if any. */
export function principalOf(req: IncomingMessage): RequestPrincipal | undefined {
  return principals.get(req);
}

/**
 * Handler parameter with the signed-in customer: `@CurrentUser() user: RequestPrincipal`.
 * On a protected route the guard guarantees it; on an `optional`/`public` route without a session
 * it throws 401 rather than handing `undefined` to code that assumed a user — use
 * `@CurrentUser({ optional: true })` there.
 */
export const CurrentUser = createParamDecorator(
  (options: { optional?: boolean } | undefined, ctx: ExecutionContext) => {
    const principal = principalOf(ctx.switchToHttp().getRequest<IncomingMessage>());
    if (!principal && !options?.optional) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Not signed in.');
    }
    return principal;
  },
);

/**
 * Owner scoping (authz scaffold for every customer-owned table from Phase 3 on): put
 * `ownedBy(user)` into the `where` of every query for a customer-owned row, so another user's row
 * is simply not found. Combine with {@link foundOr404}: a row of another user answers 404
 * `NOT_FOUND`, exactly like a row that does not exist (no existence oracle, never 403).
 */
export function ownedBy(principal: RequestPrincipal): { userId: string } {
  return { userId: principal.userId };
}

/** Returns the value, or throws 404 `NOT_FOUND` for `null`/`undefined`. */
export function foundOr404<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new ApiException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
  }
  return value;
}
