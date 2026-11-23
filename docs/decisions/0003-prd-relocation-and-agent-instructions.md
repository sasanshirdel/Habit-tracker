# ADR-0003: Relocate the PRD and make AGENTS.md concise working instructions

- **Status:** Accepted (Phase 0)
- **Date:** 2026-11-24

## Context

The repository's initial `AGENTS.md` contained the full ~2,400-line master PRD / architecture / execution plan. PRD §13.1 and §21 require both an `AGENTS.md` (agent instructions) and a `docs/PRODUCT_REQUIREMENTS.md`, and say the canonical spec must live in version-controlled documentation without contradictory duplicates across agent files. A 2,400-line instruction file is also costly for every agent session to load.

## Decision

1. The PRD was moved with `git mv` to `docs/PRODUCT_REQUIREMENTS.md` **byte-for-byte unchanged** (sha256 `ea90643505c89623cadc4b6dc7698a7ec50ec019aed2ad2e2eaf946ca1d9e5e1`). It is excluded from Prettier so it is never reformatted.
2. `AGENTS.md` is rewritten as short, actionable working instructions (conventions, workflow, commands, guardrails) that **point to** the PRD and other docs rather than restating them.
3. `CLAUDE.md` and `.github/copilot-instructions.md` exist only as pointers to `AGENTS.md`, so there is exactly one source of agent instructions.
4. The PRD is the product source of truth. Changes to scope are made by editing the PRD in a reviewed PR (with an ADR when architectural).

## Consequences

- Agents load a small file first and open the PRD sections they need.
- Git history keeps the PRD's provenance (rename detected).
- If AGENTS.md and the PRD ever disagree on product behaviour, the PRD wins; AGENTS.md wins on _how to work in this repo_.
