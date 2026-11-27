import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';

/**
 * React Hook Form resolver for the shared zod schemas (backlog P2-09). A dozen lines instead of
 * `@hookform/resolvers` (which declares ~20 optional peer dependencies and pulls
 * `@standard-schema/utils`); typed structurally, so `apps/web` needs no direct `zod` dependency.
 *
 * Each field gets the **first** issue on its path, with the issue's `code` as the error `type`
 * (`invalid_format`, `too_small`, `too_big`, …) — the form turns codes into localized text; the
 * schema's English `message` is never shown. On success the form receives the schema's output
 * (e.g. the trimmed, lower-cased email and the NFKC-normalised password the API expects).
 */
export interface SchemaIssue {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  minimum?: unknown;
  maximum?: unknown;
}

export interface SafeParseSchema<Output> {
  safeParse(
    input: unknown,
  ):
    { success: true; data: Output } | { success: false; error: { issues: readonly SchemaIssue[] } };
}

export function schemaResolver<Input extends FieldValues, Output extends FieldValues>(
  schema: SafeParseSchema<Output>,
): Resolver<Input, unknown, Output> {
  return (values) => {
    const result = schema.safeParse(values);
    if (result.success) return { values: result.data, errors: {} };
    const errors: Record<string, { type: string; message: string }> = {};
    for (const issue of result.error.issues) {
      const name = issue.path.map(String).join('.');
      if (name && !(name in errors)) errors[name] = { type: issue.code, message: issue.code };
    }
    return { values: {}, errors: errors as FieldErrors<Input> };
  };
}
