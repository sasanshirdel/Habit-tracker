import { describe, expect, it } from 'vitest';
import { ApiError, type ErrorCode } from './errors';
import {
  MAX_QUERY_RETRIES,
  getQueryClient,
  makeQueryClient,
  queryRetryDelay,
  shouldRetryQuery,
} from './query-client';

const err = (code: ErrorCode) => new ApiError(code, code);

describe('query retries', () => {
  it.each<ErrorCode>([
    'NETWORK_ERROR',
    'TIMEOUT',
    'INTERNAL_ERROR',
    'SERVICE_UNAVAILABLE',
    'NOT_READY',
  ])('retries %s up to the limit', (code) => {
    expect(shouldRetryQuery(0, err(code))).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES - 1, err(code))).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, err(code))).toBe(false);
  });

  it.each<ErrorCode>([
    'RATE_LIMITED',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'CONFLICT',
    'INVALID_RESPONSE',
  ])('never retries %s', (code) => {
    expect(shouldRetryQuery(0, err(code))).toBe(false);
  });

  it('never retries errors that are not ApiErrors', () => {
    expect(shouldRetryQuery(0, new TypeError('bug'))).toBe(false);
  });

  it('backs off exponentially, capped at 8 s', () => {
    expect([0, 1, 2, 3, 4].map(queryRetryDelay)).toEqual([1000, 2000, 4000, 8000, 8000]);
  });
});

describe('query client defaults', () => {
  it('uses the retry policy for queries, none for mutations, and a 30 s stale time', () => {
    const defaults = makeQueryClient().getDefaultOptions();
    expect(defaults.queries?.retry).toBe(shouldRetryQuery);
    expect(defaults.queries?.retryDelay).toBe(queryRetryDelay);
    expect(defaults.queries?.staleTime).toBe(30_000);
    expect(defaults.mutations?.retry).toBe(false);
  });

  it('never shares a client between server renders', () => {
    expect(getQueryClient()).not.toBe(getQueryClient());
  });
});
