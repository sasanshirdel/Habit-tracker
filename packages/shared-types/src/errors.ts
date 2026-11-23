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
