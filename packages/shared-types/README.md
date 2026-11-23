# @habit/shared-types

Type-only API contracts shared by `apps/web` and `apps/api`: health/readiness responses, the
error envelope `{ error: { code, message, details?, requestId } }` with the `ApiErrorCode` union
and `ValidationErrorDetails`, and `Paginated<T>` (ARCHITECTURE §5, ADR-0009; enforced by the API
since P1-05). Type-level tests (`expectTypeOf`) guard the shapes. Consumed through
`dist/` — run `pnpm build:packages` first.
