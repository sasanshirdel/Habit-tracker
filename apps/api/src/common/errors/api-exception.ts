import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorCode } from '@habit/shared-types';

/**
 * The API's error type (backlog P1-05). Throw it from controllers/services with a stable `code`;
 * the global filter renders `{ error: { code, message, details?, requestId } }`.
 *
 * `message` is developer-facing English and must not contain personal data, secrets or values
 * echoed from the request; clients show localised text chosen by `code`.
 */
export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message, status);
  }
}

/** Default code for an HTTP status when an error carries none (e.g. Nest's built-in exceptions). */
export function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  }
}
