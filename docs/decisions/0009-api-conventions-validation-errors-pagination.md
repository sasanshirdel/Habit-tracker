# ADR-0009: API conventions — zod validation, error envelope, cursor pagination, request ids

- **Status:** Accepted (Phase 1, backlog P1-05)
- **Date:** 2026-11-24

## Context

ARCHITECTURE §5 fixes the error shape `{ error: { code, message, details?, requestId } }` and left
two things to Phase 1: the DTO validation library (zod or class-validator) and the pagination /
sorting / filtering conventions. PRD §5 and SECURITY.md also require stable error codes the client
localises, no internals in error responses, and request ids that let support link a user's report
to server logs. The web app already validates forms with the zod schemas in
`@habit/shared-validation` (P1-04).

## Decision

### Validation: zod (no class-validator)

- Request input is validated at the edge by **`ZodValidationPipe(schema)`**
  (`apps/api/src/common/validation/`), applied per parameter:
  `@Body(new ZodValidationPipe(schema))`, `@Query(...)`, `@Param(...)`. The handler receives
  the schema's output (coerced, defaults applied).
- Schemas that the web also needs live in `@habit/shared-validation`. API-only schemas live next
  to their module. Bodies use strict objects (`z.strictObject`) so unknown fields are rejected.
- Failures → **400 `VALIDATION_FAILED`** with
  `details.issues[] = { field: '<body|query|param>.<path>', code: <zod issue code>, message }`.
  Values are never echoed.
- zod 4.6.7 is already pinned (ADR-0001), so this adds **no dependency**.

### Error envelope

- A global **`AllExceptionsFilter`** renders every failure as
  `{ error: { code, message, details?, requestId } }`.
- `ApiException(status, code, message, details?)` carries API-authored codes and messages.
- Nest's built-in HTTP exceptions get a code by status and a generic message. Their own text is
  dropped because it can echo paths or internal reasons.
- Body-parser failures map to `MALFORMED_REQUEST_BODY` (400), `PAYLOAD_TOO_LARGE` (413; the JSON
  limit is 100 kB) and `UNSUPPORTED_MEDIA_TYPE` (415). Domain errors with a code map too, e.g.
  `QUEUE_UNAVAILABLE` → 503.
- Anything else → 500 `INTERNAL_ERROR` with a fixed message. It is logged server-side with the
  request id and stack.
- Responses never include stack traces or driver/framework messages, **in any environment**.
  This is simpler and safer than a production-only switch.
- Codes are the `ApiErrorCode` union in `@habit/shared-types`. Adding a code is compatible;
  renaming or removing one is a breaking change.
- Readiness failures use the envelope (503 `NOT_READY`, `details.checks`).

### Request ids

- `requestIdMiddleware` runs first. It accepts a caller's `x-request-id` only if it matches
  `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$` (proxies/load balancers may set one); otherwise it
  generates a UUID.
- The id is echoed in the `x-request-id` response header on every response (including 404s and
  body-parse errors, because Nest's own body parser is replaced by one registered after the
  middleware) and in every error body.
- The id is stored in an `AsyncLocalStorage` request context (`currentRequestId()`) so logging
  (P1-07) can attach it to every line.

### Pagination, sorting, filtering

- **Cursor (keyset) pagination** for every list endpoint: `?limit=&cursor=`
  (`paginationQuerySchema`: limit 1–100, default 20).
- The cursor is opaque base64url JSON holding the sort key(s) and id of the last row. The server
  decodes it with a schema (`decodeCursor`) and answers malformed or tampered cursors with 400
  `INVALID_CURSOR`.
- Queries fetch `limit + 1` rows ordered by the sort key(s) and then id. `paginate()` returns
  `{ data, page: { nextCursor, hasMore, limit } }` (`Paginated<T>`).
- Cursors are not a security boundary: owner scoping still applies to every query.
- **Sorting:** `?sort=-createdAt,name` through `sortSchema(allowedFields, defaultSort)`. Only
  whitelisted (indexed) fields are allowed and duplicates are rejected.
- **Filtering:** explicit, typed query parameters per endpoint, validated by that endpoint's
  schema (e.g. `?status=active&from=2026-11-01`). There is no generic filter DSL, which keeps
  queries indexable and authorization obvious.

## Alternatives considered

- **class-validator + class-transformer + Nest `ValidationPipe`**: idiomatic Nest and integrates
  with `@nestjs/swagger` decorators. Rejected because it adds two dependencies and duplicates the
  rules already in the shared zod schemas the web uses, and its decorator-based classes cannot be
  shared with the frontend. OpenAPI generation from zod is handled in P1-06.
- **A global zod pipe driven by metadata**: needs a custom decorator per parameter anyway. The
  explicit per-parameter pipe is clearer and fully typed.
- **Offset pagination**: simpler, but unstable under concurrent inserts and slow on deep pages.
  Admin tables may still use offsets later if needed.
- **Showing stack traces in development responses**: rejected. Logs carry them, and responses stay
  identical across environments, so tests prove the production behaviour.

## Consequences

- Every endpoint must declare a schema for each input it reads. Responses stay typed DTOs (never
  Prisma entities).
- Clients localise by `code` and can show field errors from `details.issues[].field`.
- P1-06 (OpenAPI) must produce schemas from zod. P1-07 (logging) builds on `currentRequestId()`.
  P1-12 (web data layer) consumes `ApiErrorBody` / `Paginated<T>`.
- An architecture test (P1-15) can later enforce "no handler parameter without a pipe".
