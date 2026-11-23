# ADR-0008: Branching, CI gates and review

- **Status:** Accepted (Phase 0); branch protection to be configured on GitHub by the owner
- **Date:** 2026-11-24

## Decision

- **Trunk-based with short-lived branches** off `main`: `phase-N/<slug>`, `feature/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`. No long-lived `develop` branch until release cadence requires it (PRD §13.3 "when needed").
- **Every change lands through a PR.** AI agents never push to `main`.
- **Required CI check:** `CI / verify` (format, lint, typecheck, Prisma validate, test, build) on every PR and push to `main`.
- **Branch protection on `main` (owner to enable):** require PR, require `CI / verify`, require ≥1 approving review (owner), dismiss stale approvals, block force-push and deletion, require linear history (squash merge).
- **Conventional Commits** for messages (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`), scoped where useful (`feat(api): …`).
- **Human approval required** for the PRD §13.5 list (significant merges, production deploys, destructive migrations, payment activation, security-critical settings, owner identity/permissions, production data deletion).
- **CI permissions:** `contents: read` by default; jobs request more only when needed.

## Consequences

- `main` is always releasable once protection is enabled.
- Planned additions (backlog): dependency review / `pnpm audit`, secret scanning, CodeQL, Playwright job, Postgres service container for integration tests.
