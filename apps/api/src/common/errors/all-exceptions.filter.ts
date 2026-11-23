import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { ApiErrorBody, ApiErrorCode } from '@habit/shared-types';
import { REQUEST_ID_HEADER, resolveRequestId } from '../request/request-context.js';
import type { RequestWithId } from '../request/request-id.middleware.js';
import { ApiException, codeForStatus } from './api-exception.js';

/** Messages for errors that carry no API-authored message (never echo framework/driver text). */
const GENERIC_MESSAGES: Record<ApiErrorCode, string> = {
  BAD_REQUEST: 'Bad request.',
  VALIDATION_FAILED: 'Request validation failed.',
  INVALID_CURSOR: 'Invalid pagination cursor.',
  MALFORMED_REQUEST_BODY: 'Request body is not valid JSON.',
  UNAUTHENTICATED: 'Authentication required.',
  FORBIDDEN: 'Not allowed.',
  NOT_FOUND: 'Not found.',
  METHOD_NOT_ALLOWED: 'Method not allowed.',
  CONFLICT: 'Conflict.',
  PAYLOAD_TOO_LARGE: 'Request body too large.',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type or encoding.',
  RATE_LIMITED: 'Too many requests.',
  INTERNAL_ERROR: 'Internal server error.',
  NOT_READY: 'Service not ready.',
  SERVICE_UNAVAILABLE: 'Service unavailable.',
  QUEUE_UNAVAILABLE: 'Background processing is temporarily unavailable.',
};

/** Errors raised by the JSON body parser (raw-body/body-parser) before routing. */
const BODY_PARSER_ERRORS: Record<string, { status: number; code: ApiErrorCode }> = {
  'entity.parse.failed': { status: 400, code: 'MALFORMED_REQUEST_BODY' },
  'entity.too.large': { status: 413, code: 'PAYLOAD_TOO_LARGE' },
  'encoding.unsupported': { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  'charset.unsupported': { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  'request.aborted': { status: 400, code: 'BAD_REQUEST' },
};

export interface MappedError {
  status: number;
  error: Omit<ApiErrorBody['error'], 'requestId'>;
  /** Unexpected errors are logged with their stack; expected client errors are not. */
  unexpected: boolean;
}

function hasStringProp<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return typeof value === 'object' && value !== null && typeof (value as never)[key] === 'string';
}

/**
 * Maps anything thrown while handling a request to the API error envelope (backlog P1-05).
 * Pure, so every branch is unit-tested. Never returns stack traces, driver messages or input
 * values — only stable codes, API-authored messages and structured details.
 */
export function mapException(exception: unknown): MappedError {
  if (exception instanceof ApiException) {
    const error: MappedError['error'] = { code: exception.code, message: exception.message };
    if (exception.details !== undefined) error.details = exception.details;
    return { status: exception.getStatus(), error, unexpected: exception.getStatus() >= 500 };
  }
  // Domain errors with a known code (e.g. QueueUnavailableError from the queue module).
  if (hasStringProp(exception, 'code') && exception.code === 'QUEUE_UNAVAILABLE') {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      error: { code: 'QUEUE_UNAVAILABLE', message: GENERIC_MESSAGES.QUEUE_UNAVAILABLE },
      unexpected: false,
    };
  }
  // Body-parser errors arrive raw or wrapped by Nest's Express adapter (as `cause`).
  const parserError = hasStringProp(exception, 'type')
    ? exception
    : exception instanceof HttpException && hasStringProp(exception.cause, 'type')
      ? exception.cause
      : undefined;
  if (parserError && parserError.type in BODY_PARSER_ERRORS) {
    const known = BODY_PARSER_ERRORS[parserError.type] as { status: number; code: ApiErrorCode };
    return {
      status: known.status,
      error: { code: known.code, message: GENERIC_MESSAGES[known.code] },
      unexpected: false,
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = codeForStatus(status);
    return { status, error: { code, message: GENERIC_MESSAGES[code] }, unexpected: status >= 500 };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    error: { code: 'INTERNAL_ERROR', message: GENERIC_MESSAGES.INTERNAL_ERROR },
    unexpected: true,
  };
}

/**
 * Global exception filter: every failing request answers with
 * `{ error: { code, message, details?, requestId } }` and the `x-request-id` header.
 * Unexpected errors are logged server-side with the request id (structured, redacted logging
 * arrives with backlog P1-07); the response never contains internals, in any environment.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res: unknown = http.getResponse();
    const { httpAdapter } = this.adapterHost;

    let requestId = req.requestId;
    if (!requestId) {
      requestId = resolveRequestId(undefined);
      req.requestId = requestId;
    }
    const mapped = mapException(exception);
    if (mapped.unexpected) {
      const name = exception instanceof Error ? exception.name : typeof exception;
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`[${requestId}] ${mapped.error.code} (${name})`, stack);
    }
    if (httpAdapter.isHeadersSent(res)) return;
    const body: ApiErrorBody = { error: { ...mapped.error, requestId } };
    httpAdapter.setHeader(res, REQUEST_ID_HEADER, requestId);
    httpAdapter.reply(res, body, mapped.status);
  }
}
