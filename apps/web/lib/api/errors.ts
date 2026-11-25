import {
  API_ERROR_CODES,
  codeForStatus,
  isApiErrorCode,
  type ApiErrorCode,
} from '@habit/shared-types';

/**
 * Failures that happen before the API could answer (backlog P1-12). They have no HTTP status and
 * no request ID, and the UI localises them like API codes.
 * - `NETWORK_ERROR`: the request never got a response (offline, DNS, CORS refused, server down).
 * - `TIMEOUT`: no response within the client's timeout.
 * - `INVALID_RESPONSE`: a response arrived but is not the JSON the API sends.
 */
export const CLIENT_ERROR_CODES = ['NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE'] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

/** Every code an `ApiError` can carry — and therefore every code the UI has a message for. */
export const ERROR_CODES = [...API_ERROR_CODES, ...CLIENT_ERROR_CODES] as const;
export type ErrorCode = ApiErrorCode | ClientErrorCode;

export interface ApiErrorInit {
  status?: number;
  requestId?: string;
  details?: unknown;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * Every failed API call rejects with this (aborts by the caller excepted, which keep their
 * `AbortError` so TanStack Query can cancel quietly). `message` is developer-facing; show the
 * localized text for `code` instead (`useErrorMessage`).
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ErrorCode;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly details: unknown;
  /** From `details.retryAfterSeconds` of `RATE_LIMITED`, else the `Retry-After` header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, init: ApiErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** The code of a non-2xx response: the envelope's when valid, else derived from the status. */
export function codeFromResponse(status: number, envelopeCode: unknown): ApiErrorCode {
  return isApiErrorCode(envelopeCode) ? envelopeCode : codeForStatus(status);
}

/** `Retry-After` as seconds: delta-seconds or an HTTP date; `undefined` when absent or invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}
