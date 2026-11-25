/**
 * Error envelope returned by every failing API request (ARCHITECTURE §5). `code` is stable and
 * machine-readable; the client localises it — the API never sends prose meant for display.
 * Enforced globally by the API exception filter from backlog P1-05; declared here so web and
 * api share one definition.
 */
export interface ApiErrorBody {
  error: {
    /** Stable, upper snake case, e.g. `VALIDATION_FAILED`. */
    code: string;
    /** Developer-facing summary (English); never shown to end users as-is. */
    message: string;
    /** Optional structured details, e.g. field-level validation issues. */
    details?: unknown;
    /** Correlates with server logs (`x-request-id`). */
    requestId: string;
  };
}

/**
 * Stable error codes the API emits (backlog P1-05), as a runtime list so the API's OpenAPI schema
 * and the web app's localized messages are checked against the same values (P1-12). Clients
 * switch on these and localise them; adding a code is backwards compatible, renaming or removing
 * one is a breaking change.
 */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'INVALID_CURSOR',
  'MALFORMED_REQUEST_BODY',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'NOT_READY',
  'SERVICE_UNAVAILABLE',
  'QUEUE_UNAVAILABLE',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Whether `value` is one of the API's error codes. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Default code for an HTTP status when a response carries no error code: Nest's built-in
 * exceptions on the API, and envelope-less responses (a proxy's 429/502) in the web client.
 */
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

/** One field-level problem in a `VALIDATION_FAILED` error. Never contains the rejected value. */
export interface ValidationIssue {
  /** Where the problem is: `body`, `query` or `params`, then the dotted path, e.g. `body.name`. */
  field: string;
  /** Machine-readable reason (zod issue code), e.g. `too_small`, `invalid_type`, `unrecognized_keys`. */
  code: string;
  /** Developer-facing explanation (English); clients localise by `code`. */
  message: string;
}

/** `details` of a `RATE_LIMITED` (429) error; the `Retry-After` header carries the same value. */
export interface RateLimitErrorDetails {
  /** Seconds until the request may be retried. */
  retryAfterSeconds: number;
  /** Name(s) of the exceeded policy class, comma-separated, e.g. `auth`. */
  policy: string;
}

/** `details` of a `VALIDATION_FAILED` error. */
export interface ValidationErrorDetails {
  issues: ValidationIssue[];
}
