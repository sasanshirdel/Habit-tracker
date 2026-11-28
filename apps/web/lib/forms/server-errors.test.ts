import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { applyServerFieldErrors, serverFieldErrors, validationIssuesOf } from './server-errors';

// Backlog P2-09 (ADR-0027): the API's VALIDATION_FAILED issues on the matching form field.

function validationError(issues: unknown) {
  return new ApiError('VALIDATION_FAILED', 'Request validation failed.', {
    status: 400,
    details: { issues },
  });
}

const issue = (field: string, code: string) => ({ field, code, message: 'English, never shown' });

describe('validationIssuesOf', () => {
  it('returns the issues of a VALIDATION_FAILED error only, skipping malformed entries', () => {
    const error = validationError([issue('body.email', 'invalid_format'), { field: 1 }, null]);
    expect(validationIssuesOf(error)).toEqual([issue('body.email', 'invalid_format')]);
    expect(validationIssuesOf(new ApiError('RATE_LIMITED', 'x', { status: 429 }))).toEqual([]);
    expect(validationIssuesOf(new ApiError('VALIDATION_FAILED', 'x'))).toEqual([]);
    expect(validationIssuesOf(validationError('not a list'))).toEqual([]);
    expect(validationIssuesOf(new Error('x'))).toEqual([]);
  });
});

describe('serverFieldErrors', () => {
  it('maps body paths to fields in the form order, first issue per field', () => {
    const error = validationError([
      issue('body.timezone', 'custom'),
      issue('body.locale', 'invalid_value'),
      issue('body.timezone', 'too_big'),
    ]);
    expect(serverFieldErrors(error, ['locale', 'timezone', 'theme'])).toEqual([
      { field: 'locale', code: 'invalid_value' },
      { field: 'timezone', code: 'custom' },
    ]);
  });

  it('matches nested paths and renamed fields, never other request parts or unknown keys', () => {
    const error = validationError([
      issue('body.name.first', 'too_small'),
      issue('query.limit', 'too_big'),
      issue('body.passwordConfirmation', 'unrecognized_keys'),
      issue('body.tz', 'custom'),
    ]);
    expect(serverFieldErrors(error, ['name', 'password', 'limit', 'zone'], { zone: 'tz' })).toEqual(
      [
        { field: 'name', code: 'too_small' },
        { field: 'zone', code: 'custom' },
      ],
    );
  });
});

describe('applyServerFieldErrors', () => {
  it('sets each field error with the issue code as type and focuses the first field', () => {
    const setError = vi.fn();
    const setFocus = vi.fn();
    const error = validationError([
      issue('body.password', 'too_small'),
      issue('body.email', 'invalid_format'),
    ]);
    expect(applyServerFieldErrors(error, { setError, setFocus }, ['email', 'password'])).toBe(true);
    expect(setError.mock.calls).toEqual([
      ['email', { type: 'invalid_format', message: 'invalid_format' }],
      ['password', { type: 'too_small', message: 'too_small' }],
    ]);
    expect(setFocus).toHaveBeenCalledExactlyOnceWith('email');
  });

  it('returns false (form-level message) when no issue matches a field of the form', () => {
    const setError = vi.fn();
    const setFocus = vi.fn();
    const hidden = validationError([issue('body.timezone', 'custom')]);
    expect(applyServerFieldErrors(hidden, { setError, setFocus }, ['email'])).toBe(false);
    const other = new ApiError('INTERNAL_ERROR', 'x', { status: 500 });
    expect(applyServerFieldErrors(other, { setError, setFocus }, ['email'])).toBe(false);
    expect(setError).not.toHaveBeenCalled();
    expect(setFocus).not.toHaveBeenCalled();
  });
});
