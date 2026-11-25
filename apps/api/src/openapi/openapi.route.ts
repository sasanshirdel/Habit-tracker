import type { ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ApiErrorBody } from '@habit/shared-types';
import { resolveRequestId } from '../common/request/request-context.js';
import type { RequestWithId } from '../common/request/request-id.middleware.js';
import { buildOpenApiDocument } from './openapi.document.js';

/** Where the document is served when enabled. Outside `/api/v1`: it describes the API, it is not part of it. */
export const API_DOCS_PATH = '/api/docs/openapi.json';

/**
 * Registers {@link API_DOCS_PATH} (backlog P1-06, ADR-0012).
 *
 * - `enabled` (`apiDocsEnabled(env)`): serves the document. It is built on first request and
 *   cached for the life of the process.
 * - disabled: answers 404 `NOT_FOUND` in the standard envelope, exactly like an unknown route.
 *   (Nest's own not-found handler only covers the `/api/v1` prefix; without this the path would
 *   get Express's default HTML 404.)
 *
 * The route is a plain Express handler registered before Nest's router, so it gets the app's
 * middleware (security headers, request id, access log, CORS) but no Nest guard: it is not
 * rate-limited, which is acceptable for a cached, read-only document that is off in production.
 */
export function registerApiDocs(
  app: NestExpressApplication,
  basePath: string,
  options: { enabled: boolean },
): void {
  const logger = new Logger('OpenApi');
  let body: string | undefined;
  app.getHttpAdapter().get(API_DOCS_PATH, (req: RequestWithId, res: ServerResponse) => {
    const requestId = req.requestId ?? resolveRequestId(undefined);
    if (!options.enabled) {
      sendError(res, 404, { code: 'NOT_FOUND', message: 'Not found.', requestId });
      return;
    }
    try {
      body ??= JSON.stringify(buildOpenApiDocument(app.get(ModulesContainer), { basePath }));
    } catch (error) {
      logger.error({ msg: 'OpenAPI document could not be built', err: error });
      sendError(res, 500, { code: 'INTERNAL_ERROR', message: 'Internal server error.', requestId });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(body);
  });
}

function sendError(res: ServerResponse, status: number, error: ApiErrorBody['error']): void {
  const failure: ApiErrorBody = { error };
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(failure));
}
