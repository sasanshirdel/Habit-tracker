import type { ValidationIssue } from '@habit/shared-types';
import type { FieldPath, FieldValues, UseFormSetError, UseFormSetFocus } from 'react-hook-form';
import { isApiError } from '@/lib/api/errors';

/**
 * Server-side validation errors on the matching form field (backlog P2-09, ADR-0027).
 *
 * The forms validate with the API's own shared zod schemas first, so a `400 VALIDATION_FAILED` is
 * rare — but the API stays the authority (a value the browser accepted can still be refused: an
 * IANA zone the server's ICU data lacks, a normalisation difference, a request changed in flight).
 * Its envelope lists `details.issues[]` with `field` (`body.<path>`), a zod issue `code` and an
 * English developer message (ADR-0009). This module maps those issues onto the form's own fields
 * by path, using the issue `code` as the error `type` — exactly the shape `schemaResolver` gives
 * client-side errors — so every form shows server errors with its existing localized messages,
 * `aria-invalid` and `aria-describedby`. The English message is never shown.
 *
 * Issues on parts of the request that are not fields of the form (a hidden locale, a token, an
 * unknown key) are left to the form-level message.
 */

/** Request part the forms send their fields in. */
const BODY = 'body.';

function isIssue(value: unknown): value is ValidationIssue {
  if (!value || typeof value !== 'object') return false;
  const issue = value as Partial<ValidationIssue>;
  return typeof issue.field === 'string' && typeof issue.code === 'string';
}

/** The `details.issues` of a `VALIDATION_FAILED` `ApiError`; empty for anything else. */
export function validationIssuesOf(error: unknown): ValidationIssue[] {
  if (!isApiError(error) || error.code !== 'VALIDATION_FAILED') return [];
  const issues = (error.details as { issues?: unknown } | undefined)?.issues;
  return Array.isArray(issues) ? issues.filter(isIssue) : [];
}

/**
 * The first issue code per form field, in the order of `fields` (the form's visual order). An
 * API path is matched as `body.<field>`, or `body.<apiName>` when `rename` maps a form field to
 * a different request name.
 */
export function serverFieldErrors<Field extends string>(
  error: unknown,
  fields: readonly Field[],
  rename: Partial<Record<Field, string>> = {},
): { field: Field; code: string }[] {
  const issues = validationIssuesOf(error);
  const found: { field: Field; code: string }[] = [];
  for (const field of fields) {
    const path = `${BODY}${rename[field] ?? field}`;
    const issue = issues.find((i) => i.field === path || i.field.startsWith(`${path}.`));
    if (issue) found.push({ field, code: issue.code });
  }
  return found;
}

/**
 * Applies a failed submit's field issues to a React Hook Form form: each field gets its error
 * (type = issue code, as `schemaResolver` does) and focus moves to the **first** invalid field.
 * Returns `true` when at least one field took an error — the caller then shows no form-level
 * alert, like a client-side validation failure; `false` means the caller shows its form-level
 * message as before. The error clears when the field is edited (`reValidateMode: 'onChange'`
 * re-runs the shared schema).
 */
export function applyServerFieldErrors<Values extends FieldValues>(
  error: unknown,
  form: { setError: UseFormSetError<Values>; setFocus: UseFormSetFocus<Values> },
  fields: readonly FieldPath<Values>[],
  rename: Partial<Record<FieldPath<Values>, string>> = {},
): boolean {
  const found = serverFieldErrors(error, fields, rename);
  for (const { field, code } of found) {
    form.setError(field, { type: code, message: code });
  }
  const first = found[0];
  if (!first) return false;
  form.setFocus(first.field);
  return true;
}
