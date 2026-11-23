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
 * Stable error codes the API emits (backlog P1-05). Clients switch on these and localise them;
 * adding a code is backwards compatible, renaming or removing one is a breaking change.
 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'INVALID_CURSOR'
  | 'MALFORMED_REQUEST_BODY'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'NOT_READY'
  | 'SERVICE_UNAVAILABLE'
  | 'QUEUE_UNAVAILABLE';

/** One field-level problem in a `VALIDATION_FAILED` error. Never contains the rejected value. */
export interface ValidationIssue {
  /** Where the problem is: `body`, `query` or `params`, then the dotted path, e.g. `body.name`. */
  field: string;
  /** Machine-readable reason (zod issue code), e.g. `too_small`, `invalid_type`, `unrecognized_keys`. */
  code: string;
  /** Developer-facing explanation (English); clients localise by `code`. */
  message: string;
}

/** `details` of a `VALIDATION_FAILED` error. */
export interface ValidationErrorDetails {
  issues: ValidationIssue[];
}
