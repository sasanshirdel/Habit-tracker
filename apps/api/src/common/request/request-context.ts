import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Per-request context, available anywhere in the async call chain of a request. */
export interface RequestContext {
  readonly requestId: string;
  /**
   * The authenticated user, once known. Set by the authentication guard (backlog P2-03) through
   * `setRequestUserId`; logging adds it to every later line of the request (P1-07).
   */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Incoming request ids (e.g. from a reverse proxy) are accepted only in this shape, so a client
 * cannot inject line breaks, markup or huge values into logs and responses.
 */
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** Returns the caller's id when it is acceptable, otherwise a new UUID. */
export function resolveRequestId(incoming: unknown): string {
  return typeof incoming === 'string' && ACCEPTED_REQUEST_ID.test(incoming)
    ? incoming
    : randomUUID();
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The current request's id, or `undefined` outside a request (boot, worker jobs). Logging
 * (backlog P1-07) attaches it to every line; the error filter puts it in every error body.
 */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** The current request's context, or `undefined` outside a request. */
export function currentRequestContext(): Readonly<RequestContext> | undefined {
  return storage.getStore();
}

/**
 * Records the authenticated user for the rest of the request (logs then carry `userId`). A no-op
 * outside a request. Only an opaque internal id belongs here — never an email or a name.
 */
export function setRequestUserId(userId: string): void {
  const context = storage.getStore();
  if (context) context.userId = userId;
}
