# ADR-0002: Monorepo layout and workspace tooling

- **Status:** Accepted (Phase 0)
- **Date:** 2026-11-24

## Context

PRD §5.3 asks for a monorepo with `apps/web`, `apps/api`, `apps/worker` and shared `packages/*`, "adjusted when implementation evidence justifies". We want the smallest setup that builds, tests and lints every package with one command in CI.

## Decision

- **pnpm workspaces** (`pnpm-workspace.yaml`: `apps/*`, `packages/*`). Strict, content-addressed installs, and a built-in `allowBuilds` allow-list for install scripts.
- **No Turborepo/Nx yet.** Root scripts call `pnpm -r --if-present run <task>`. A task runner is added only when CI time or caching needs justify it (backlog item).
- **Phase 0 packages:**
  - `apps/web` — Next.js frontend.
  - `apps/api` — NestJS REST API (modular monolith; ADR-0006).
  - `packages/config` — shared `tsconfig` presets and flat ESLint config.
  - `packages/ui` — design tokens now; shared UI primitives from Phase 1.
- **Added later, when first needed:** `apps/worker` (BullMQ consumer, Phase 1), `apps/admin` (separate admin app, Phase 10; ADR-0005), `packages/shared-types`, `packages/shared-validation`, `packages/localization` (Phase 1).
- **Package scope:** `@habit/*`, private, `workspace:*` references.
- **Module system:** ESM everywhere (`"type": "module"`); NestJS 12 is ESM-only.
- **Docs layout:** top-level docs in `docs/*.md` (as PRD §21 lists), ADRs in `docs/decisions/`, backlog in `docs/backlog/`. The deeper `docs/<area>/` folders in PRD §5.3 are created as content appears.

## Consequences

- One `pnpm install` and five root commands (`format:check`, `lint`, `typecheck`, `test`, `build`) cover the whole repo.
- Without a task runner, builds are not cached; acceptable at current size.
- Adding a package = new folder under `apps/` or `packages/` with the standard scripts; CI picks it up automatically.
