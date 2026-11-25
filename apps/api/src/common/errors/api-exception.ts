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

/**
 * Default code for an HTTP status when an error carries none (e.g. Nest's built-in exceptions).
 * Lives in `@habit/shared-types` since P1-12, so the web client maps envelope-less responses
 * (a proxy's 429/502) the same way.
 */
export { codeForStatus } from '@habit/shared-types';
