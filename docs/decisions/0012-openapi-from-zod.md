# ADR-0012: OpenAPI generated from zod

- **Status:** Accepted (Phase 1, backlog P1-06)
- **Date:** 2026-11-25

## Context

Backlog P1-06 asks for a valid OpenAPI document generated from the API, published outside
production, exported by CI, and never exposing admin endpoints. The issue's original scope named
`@nestjs/swagger` and an HTML page at `/api/docs`. Since then ADR-0009 made zod the only validation
layer (`ZodValidationPipe` per parameter, no class-validator DTOs) and ADR-0011 gave every API
response a deny-all CSP (`default-src 'none'`). Both change what a good OpenAPI setup looks like:
the request schemas already exist as zod objects, and an HTML documentation page cannot run under
the API's CSP. zod 4 (pinned 4.6.7) converts schemas to JSON Schema draft 2020-12 itself
(`z.toJSONSchema`), which is the schema dialect of OpenAPI 3.1.

## Decision

### Generated from the schemas the server enforces

- `apps/api/src/openapi/` builds an **OpenAPI 3.1.1** document by scanning the app's controllers
  (Nest route metadata) — no `@nestjs/swagger`, no new dependency.
- **Requests:** parameters and bodies are read from each route's `ZodValidationPipe`s and converted
  with `z.toJSONSchema(…, { io: 'input' })`, so the document shows exactly what is validated
  (before defaults/coercion). Request schemas are kept self-contained (no component `$ref`s).
- **Responses:** each handler declares `@ApiDoc({ operationId, summary, responses })` with zod
  response schemas (`src/health/health.schemas.ts` for the probes). Schemas published as named
  components use `component(schema, { id })`; nesting one in another schema yields a
  `#/components/schemas/<id>` `$ref`. Response objects are documented **open** (no
  `additionalProperties: false`) because adding a response field is a compatible change
  (ADR-0009); the zod schemas stay strict, so tests that parse real responses with them catch an
  undocumented field.
- **Shared contracts:** the TypeScript interfaces in `@habit/shared-types` stay the source the web
  imports; the zod mirrors (`ApiError`, `ValidationFailedError`, `RateLimitedError`, `PageInfo`,
  `HealthResponse`, `ReadinessResponse`, …) are pinned to them by compile-time type-equality tests,
  and e2e/integration tests parse real responses with them.
- **Generated, not hand-written:** the 400 `VALIDATION_FAILED` response for any route with validated
  input, 429 `RATE_LIMITED` + `Retry-After` and `RateLimit-*` headers for rate-limited routes (from
  the same `routeRateLimitPolicies()` the guard uses, plus an `x-rate-limit` extension listing the
  classes), 503 for fail-closed classes, `x-request-id` on every response and a `default` error
  envelope.
- **Strict by construction:** the generator refuses to build (failing the unit test, the CI export
  and the served route) when a route has no `@ApiDoc`/`@ApiExclude`, reads body/query/params without
  a zod pipe, has a path parameter without a schema, uses a path OpenAPI cannot express, repeats an
  `operationId`, declares no 2xx — or is an **admin route that is not excluded**. A structural
  validator (`openapi.validate.ts`: 3.1 version, path templates, unique operation ids, resolvable
  `$ref`s, no stray `$id`/`$defs`/`$schema`) runs on every export.

### Where it is published

- **JSON only, no HTML UI:** `GET /api/docs/openapi.json` (outside `/api/v1`; it describes the API,
  it is not part of the contract). A Swagger/Redoc page would need scripts and styles that the API's
  deny-all CSP forbids, and relaxing the CSP for one path is not worth it; developers open the JSON
  in their own tool (editor plugin, Swagger Editor, Bruno, …).
- The route is a plain Express handler before Nest's router: it gets the security headers, request
  id, access log and CORS, but not Nest guards, so it is **not rate-limited**. The document is built
  once on first request and cached for the process lifetime.
- **Production rule:** `API_DOCS_ENABLED` (boolean, optional). Unset → served unless
  `NODE_ENV=production`; staging runs with `NODE_ENV=production`, so it is off there too. Production
  or staging serve it only with an explicit `API_DOCS_ENABLED=true`, which logs a warning at
  startup. When disabled the path answers the standard 404 `NOT_FOUND` envelope, like any unknown
  route.
- **Admin rule:** routes under `/admin` (ADR-0005) must carry `@ApiExclude()`; the generator throws
  for any that does not, so admin endpoints can never appear in the public document even by
  accident. An excluded route is still served and validated. If admin docs are needed later they get
  a separate, authenticated document (new ADR).
- **CI:** the `verify` job runs `pnpm --filter @habit/api openapi:export` after the build. The export
  scans the built app in Nest preview mode (nothing instantiated, so no PostgreSQL, Redis or secret)
  and the job uploads `apps/api/dist/openapi.json` as the `openapi` artifact.

## Alternatives considered

Checked against the npm registry on 2026-11-25 (UTC+03:30) with `npm view`:

- **`@nestjs/swagger` 12.1.2** (last modified 2026-11-13; peers Nest `^12`, plus `class-validator`
  and `class-transformer` as peers; bundles `swagger-ui-dist` 5.34.1, `js-yaml`, `@nestjs/mapped-types`
  …). The issue's original choice. Not taken: its schemas come from DTO classes and decorators, which
  ADR-0009 rejected — every schema would be written twice (zod for validation, decorators for docs)
  and could drift; its UI conflicts with the API CSP.
- **`nestjs-zod` 5.6.0** (2026-11-08): bridges zod DTOs into `@nestjs/swagger`, but its peer range is
  Nest `^10 || ^11` and swagger `^7.4.2 || ^8 || ^11` — it does not declare our Nest 12 — and it still
  needs `@nestjs/swagger`.
- **`zod-openapi` 6.0.2** (2026-08-31) / **`@asteasolutions/zod-to-openapi` 9.1.0** (2026-07-19), both
  peers `zod ^4`: build documents from zod, but still need routes registered by hand next to the
  controllers. zod 4's built-in `z.toJSONSchema` covers the schema conversion; what remains (reading
  Nest's route metadata) is small and in-repo. Revisit if we need OpenAPI features the in-repo
  generator lacks (callbacks, links, discriminator mappings).
- **Hand-written `openapi.yaml`:** drifts from the code by default. Not taken.
- **HTML UI with a relaxed CSP on `/api/docs`:** rejected above.

## Consequences

- No new dependency (ADR-0001 addendum).
- Every new route needs `@ApiDoc` (or `@ApiExclude`); the unit test and CI fail otherwise. Response
  types that are part of a contract get a zod schema next to the controller (or a shared mirror
  pinned to `@habit/shared-types` by a type-equality test).
- Admin routes (P11) must be `@ApiExclude()`d (review checklist item; enforced by the generator).
- New env var `API_DOCS_ENABLED` (validated; documented in `.env.example`, DEVELOPMENT_WORKFLOW.md,
  SECURITY.md).
- Generated client types (P1-12 may want them) can be produced from the CI artifact; the web keeps
  importing `@habit/shared-types` until then.
- Follow-ups: P1-12 decides whether to generate a client from the artifact; P11 admin console keeps
  its routes excluded; P12-06 confirms `API_DOCS_ENABLED` stays unset in production.
