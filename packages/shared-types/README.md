# @habit/shared-types

Type-only API contracts shared by `apps/web` and `apps/api`: health/readiness responses and the
error envelope `{ error: { code, message, details?, requestId } }` (ARCHITECTURE §5; enforced by
the API from P1-05). Type-level tests (`expectTypeOf`) guard the shapes. Consumed through
`dist/` — run `pnpm build:packages` first.
