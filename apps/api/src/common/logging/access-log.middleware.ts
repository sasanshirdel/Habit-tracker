import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import { currentRequestContext, runWithRequestContext } from '../request/request-context.js';

/** Express adds these to the request after routing. */
interface RoutedRequest extends IncomingMessage {
  baseUrl?: string;
  /** The URL as received; Express rewrites `url` while routing through mounted routers. */
  originalUrl?: string;
  route?: { path?: unknown };
}

/** Raw paths of unmatched routes are cut to this length (they are attacker-controlled). */
export const MAX_LOGGED_PATH = 200;

/** Probe endpoints polled by orchestrators: logged at `debug` so they do not flood the logs. */
const PROBE_ROUTE = /\/health(\/|$)/;

export interface AccessLogFields {
  msg: string;
  http: {
    method: string;
    /** Matched route pattern, e.g. `/api/v1/habits/:id` (never ids, tokens or query strings). */
    route?: string;
    /**
     * Only when no specific route matched — no route, or a wildcard such as Nest's not-found
     * catch-all `/api/v1*path`: the raw path without its query string, truncated.
     */
    path?: string;
    status: number;
    durationMs: number;
    aborted?: true;
  };
}

/** Builds the access-log fields for a finished (or aborted) request. Pure; unit-tested. */
export function accessLogFields(
  req: RoutedRequest,
  status: number,
  durationMs: number,
  aborted: boolean,
): AccessLogFields {
  const routePath = typeof req.route?.path === 'string' ? req.route.path : undefined;
  const http: AccessLogFields['http'] = {
    method: (req.method ?? 'UNKNOWN').slice(0, 16),
    status,
    durationMs: Math.round(durationMs * 10) / 10,
  };
  if (routePath !== undefined) http.route = `${req.baseUrl ?? ''}${routePath}`;
  if (routePath === undefined || routePath.includes('*')) {
    const raw = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    http.path = raw.length > MAX_LOGGED_PATH ? `${raw.slice(0, MAX_LOGGED_PATH)}…` : raw;
  }
  if (aborted) http.aborted = true;
  return { msg: aborted ? 'request aborted' : 'request completed', http };
}

const logger = new Logger('HttpAccess');

/**
 * One structured line per request (backlog P1-07): method, route pattern, status and duration,
 * with the request's id (and user, once authenticated). Never headers, cookies, query strings or
 * bodies. Registered right after `requestIdMiddleware`, so it runs inside the request context.
 * 5xx lines are `warn` (the error itself is logged by the exception filter); probes are `debug`.
 */
export function accessLogMiddleware(
  req: RoutedRequest,
  res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  const started = process.hrtime.bigint();
  const context = currentRequestContext();
  let logged = false;
  const done = (aborted: boolean) => {
    if (logged) return;
    logged = true;
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const fields = accessLogFields(req, res.statusCode, durationMs, aborted);
    const emit = () => {
      if (fields.http.status >= 500) logger.warn(fields);
      else if (fields.http.route && PROBE_ROUTE.test(fields.http.route)) logger.debug(fields);
      else logger.log(fields);
    };
    // `finish`/`close` fire outside the request's async context; restore it for the line.
    if (context) runWithRequestContext(context, emit);
    else emit();
  };
  res.once('finish', () => done(false));
  res.once('close', () => done(!res.writableFinished));
  next();
}
