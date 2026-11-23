# ADR-0006: Modular monolith boundaries and data conventions

- **Status:** Accepted (Phase 0)
- **Date:** 2026-11-24

## Context

PRD §5.1/§5.4: start as a modular monolith with clear module boundaries so modules can be extracted later; no premature microservices. PRD §6 lists data-integrity rules (FKs, transactions, no float money, timezone correctness, history preservation).

## Decision

### Module boundaries (`apps/api/src/modules/<name>/`)

- One NestJS module per PRD §5.4 bounded area. Each exposes a **public service interface** (exported from its `index.ts`); other modules may import only that, never another module's repositories, Prisma models or internals.
- Cross-module side effects (e.g. "habit completed" → analytics, notifications) go through in-process domain events, and through BullMQ jobs when work is slow or must be retried.
- Modules own their tables. Joins across ownership boundaries happen in read models/analytics, not in another module's write path.
- An architecture test (backlog item, Phase 1) enforces the import rules.

### Data conventions

- **IDs:** UUIDv7 (time-ordered) generated in the app; never expose sequential IDs.
- **Time:** store instants as `timestamptz` in UTC; store the user's IANA timezone; habit occurrences are keyed by **local date** (`date`) + schedule version so "today" is correct across DST and travel.
- **Money:** integer minor units (`bigint`) + ISO-4217 currency; IRR stored in rials, Toman is presentation only; never floats, never implicit conversion.
- **History:** schedule versions with effective dates; corrections are new records with an audit trail, not silent updates.
- **Soft delete** (`deletedAt`) for user-facing entities where restore/retention apply; hard delete for account-deletion workflows per retention policy.
- **Optimistic concurrency:** `version` integer on entities editable offline (habits, tasks, journal) to support sync conflict detection (Phase 8).
- **Idempotency:** client operation IDs / idempotency keys for writes that can be retried (offline sync, payments, webhooks).
- **Migrations:** Prisma migrate only; destructive migrations need human approval (PRD §13.5).

## Consequences

- Clear seams for later extraction (e.g. a separate worker or billing service) without a rewrite.
- Slightly more ceremony (interfaces, events) than calling across modules directly.
