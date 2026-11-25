# ADR-0007: Testing strategy and tools

- **Status:** Accepted (Phase 0)
- **Date:** 2026-11-24

## Decision

- **Vitest 5** for unit and integration tests in every package (one runner, one config style). NestJS DI metadata is supported via `unplugin-swc`.
- **supertest** for HTTP-level tests that boot the real Nest app (`createApp()` is shared with `main.ts`, so tests exercise the same global config).
- **Database integration tests** (Phase 1+) run against a real PostgreSQL (CI service container), never mocks for repository logic; each test runs in a transaction or an isolated schema. The integration harness (`apps/api/test/integration/global-setup.ts`) creates a throwaway database per run and applies migrations with `prisma migrate deploy`.
- **Redis integration tests** (Phase 1+) run against a real Redis (CI service container / docker-compose). Every key a test writes uses the per-run prefix `habit:it:<run>:`, removed by SCAN+DEL in global teardown — never `FLUSHDB`, since a developer's Redis may be shared. The harness's own probes use a tiny dependency-free RESP2 helper (`test/integration/redis-resp.ts`, test-only); since P1-03 the apps under test use ioredis/BullMQ with `QUEUE_PREFIX` set to the run prefix. The worker is additionally tested as a real OS process (`apps/worker/test/*.int.test.ts`).
- `pnpm test:integration` (per package, `--if-present`) is the convention for tests needing real services; `pnpm test` must never need them.
- **React Testing Library + jsdom** added in Phase 1 with the first interactive components.
- **Playwright** for E2E (PRD §12 journeys), introduced in Phase 1 with a smoke test (`/en`, `/fa` render with correct `dir`) and grown per phase. Implemented in P1-13: see [ADR-0015](0015-browser-end-to-end-tests.md).
- **Property-based tests** (e.g. `fast-check`) recommended for the schedule/occurrence/streak engine in Phase 3 — the PRD requires these to be deterministic and thoroughly tested.
- **Coverage:** no global threshold yet; risk-based minimums per module (scheduling, streaks, entitlements, payments, authz) set when those modules land.

## Consequences

- Phase 0 has real but small tests: env validation, health endpoint (incl. no `x-powered-by`), i18n direction/digits/dictionary parity, design-token CSS/TS sync.
