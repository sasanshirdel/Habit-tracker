import type { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER, resolveRequestId, runWithRequestContext } from './request-context.js';

/** Request augmented with its id (set by `requestIdMiddleware`). */
export interface RequestWithId extends IncomingMessage {
  requestId?: string;
}

/**
 * First middleware of the app (backlog P1-05): gives every request an id — the caller's
 * `x-request-id` when well-formed, else a new UUID — echoes it in the `x-request-id` response
 * header (also on errors and 404s) and runs the rest of the request inside a request context so
 * logs and the error filter can read it.
 */
export function requestIdMiddleware(
  req: RequestWithId,
  res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  runWithRequestContext({ requestId }, () => next());
}
