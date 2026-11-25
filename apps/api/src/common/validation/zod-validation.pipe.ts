import { HttpStatus, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ValidationErrorDetails, ValidationIssue } from '@habit/shared-types';
import type { z } from 'zod';
import { ApiException } from '../errors/api-exception.js';

/** Converts zod issues to field-level details. Values are never copied into the response. */
export function toValidationIssues(
  issues: readonly z.core.$ZodIssue[],
  location: string,
): ValidationIssue[] {
  return issues.flatMap((issue): ValidationIssue[] => {
    const base = [location, ...issue.path.map(String)].join('.');
    if (issue.code === 'unrecognized_keys') {
      // One issue per unexpected key, so clients can point at each field.
      return issue.keys.map((key) => ({
        field: `${base}.${key}`,
        code: issue.code,
        message: 'Unrecognized field.',
      }));
    }
    return [{ field: base, code: issue.code, message: issue.message }];
  });
}

export function validationFailed(issues: ValidationIssue[]): ApiException {
  const details: ValidationErrorDetails = { issues };
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'VALIDATION_FAILED',
    'Request validation failed.',
    details,
  );
}

/**
 * Validates and transforms one request part with a zod schema (backlog P1-05, ADR-0009):
 *
 *     @Body(new ZodValidationPipe(createHabitSchema)) body: CreateHabitInput
 *     @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery
 *
 * Invalid input → 400 `VALIDATION_FAILED` with `details.issues[]` (`field`, `code`, `message`).
 * The handler receives the schema's *output* (defaults applied, strings coerced). Use strict
 * objects for bodies so unknown fields are rejected rather than silently dropped.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  /** Public so the OpenAPI generator (P1-06) documents exactly the schema that is enforced. */
  constructor(readonly schema: S) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const location = metadata.type === 'custom' ? 'input' : metadata.type;
    throw validationFailed(toValidationIssues(result.error.issues, location));
  }
}
