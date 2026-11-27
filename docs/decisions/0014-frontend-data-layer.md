# ADR-0014: Frontend data layer — typed fetch client, TanStack Query, errors localized by code

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

Every feature from Phase 2 on reads and writes the API from the browser. PRD §5 lists TanStack
Query; ARCHITECTURE §5 and ADR-0009 fix the API side: versioned REST, one error envelope
`{ error: { code, message, details?, requestId } }` with stable codes that the **client** localises,
`x-request-id` on every response, `RATE_LIMITED` with `details.retryAfterSeconds` and `Retry-After`
(ADR-0011). Sessions will be `HttpOnly` cookies with CSRF protection (ADR-0005, SECURITY §5), so
the browser must never hold a token. Backlog P1-12 (#16).

## Decision

- **Client:** an in-repo `fetch` wrapper, `apps/web/lib/api/client.ts` (`createApiClient`), typed
  with `@habit/shared-types` response types. Every request uses `credentials: 'include'` and
  `cache: 'no-store'`, sends `Accept: application/json` (and JSON bodies), and has a timeout
  (15 s). Paths must be relative to `NEXT_PUBLIC_API_BASE_URL`; absolute URLs and `//host` paths are
  rejected so credentials cannot leak to another origin.
- **CSRF:** the client has a `csrf: { headerName, getToken, onRejected }` option applied to
  state-changing methods only. Since P2-03 (ADR-0019) `lib/api/api.ts` sets it: header
  `X-CSRF-Token`, token (sync or async) from the in-memory store `lib/api/csrf.ts` (fetched from
  `GET /auth/session` on first need), and one retry after 403 `CSRF_FAILED`.
- **No tokens in web storage:** the client never reads or writes `localStorage`/`sessionStorage`
  (a test makes any access throw).
- **Errors:** every failure is an `ApiError` with `code`, `status`, `requestId`, `details` and
  `retryAfterSeconds`. A non-2xx response takes the envelope's code when it is a known
  `ApiErrorCode`, else the code for its status (`codeForStatus`, now shared with the API in
  `@habit/shared-types`) — so a proxy's envelope-less 429/502 still maps correctly. Failures without
  a response get client codes: `NETWORK_ERROR`, `TIMEOUT`, `INVALID_RESPONSE`. A cancellation by
  the caller keeps its `AbortError` (TanStack Query cancels quietly).
- **One code list:** `API_ERROR_CODES` is now a runtime array in `@habit/shared-types` (the
  `ApiErrorCode` type derives from it). The API's OpenAPI enum uses it, and a web test requires an
  `apiErrors.<CODE>` message in `en` and `fa` for every API and client code, so a new code without a
  translation fails CI. `useErrorMessage()` turns any error into localized text; `RATE_LIMITED`
  says how many seconds to wait when known. The developer `message` is never shown.
- **TanStack Query 5.108.4** (`@tanstack/react-query`, checked with `npm view` on 2026-11-25; MIT,
  React 18/19 peer; one dependency, `@tanstack/query-core` 5.108.4, no install scripts). Defaults in
  `lib/api/query-client.ts`: `staleTime` 30 s; queries retry only `NETWORK_ERROR`, `TIMEOUT`,
  `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `QUEUE_UNAVAILABLE`, `NOT_READY` — at most twice, 1 s/2 s
  backoff (cap 8 s); never 4xx or `RATE_LIMITED`; mutations never retry. A fresh `QueryClient` per
  server render, one per browser tab; `QueryProvider` sits in the locale layout.
- **Standard states:** loading = `Skeleton` with `aria-busy` on the section; error = `QueryError`
  (`role="alert"`, localized message, request ID in first-strong isolates, retry button); empty =
  `EmptyState` (P1-11). Query options live per resource in `lib/api/queries/` (`healthQueries`
  first).
- **Demo:** `/{locale}/status` (public, `noindex`) shows API liveness and readiness through the
  client; a readiness 503 `NOT_READY` is rendered as data (which dependency is down), not as an
  error.

## Alternatives considered

- **openapi-fetch / generated client from the P1-06 spec:** attractive later, but it adds a
  generator step and a dependency while there are two endpoints; the shared types already give
  typed responses. Revisit when the API surface grows (Phase 3).
- **ky / axios:** more dependencies for what ~150 lines of `fetch` do; axios's XHR adapter adds
  nothing in modern browsers.
- **SWR:** TanStack Query is what the PRD names and has mutations, cancellation and devtools.
- **Server-side fetching only (RSC):** keeps working for public data, but user data needs the
  browser's cookie against the API origin and client-side cache/invalidations; RSC prefetch +
  hydration can be added per page later.

## Consequences

- Features write `queryOptions` with the shared client and get retries, cancellation and localized
  errors for free; field-level `VALIDATION_FAILED` issues are mapped by forms in Phase 2 (P2-09 shows a generic form-level message; per-field mapping of server issues is a follow-up, ADR-0020).
- `NEXT_PUBLIC_API_BASE_URL` is required in any deployment where the API is not reverse-proxied at
  `/api/v1` on the web origin (the fallback); it also feeds the CSP `connect-src`.
- Adding an API error code needs an `apiErrors` message in both catalogues (enforced).
- P2-03 must wire the CSRF option; P1-13 can reuse `/status` for an API smoke test.
