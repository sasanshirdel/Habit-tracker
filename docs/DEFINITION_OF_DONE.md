# Definition of Done

Source: PRD §12 (Quality Gates) and §19. A change is **not done** because the UI looks right.

## Feature / issue level

A feature is done only when **all relevant** items hold:

1. The user-facing experience works end-to-end (frontend + backend + persistence).
2. Input validation exists at the API edge (and in forms for UX).
3. Authorization is enforced server-side (owner scoping for customer data; permissions for admin).
4. Entitlements are checked server-side where the feature is plan-gated.
5. Error, loading, empty, success and disabled states are handled.
6. Responsive behaviour works (mobile, tablet, desktop); touch targets are adequate.
7. Persian (RTL) and English (LTR) both work: no hardcoded strings, dictionaries updated with identical keys, layout mirrored (logical CSS), dates/numbers localised.
8. Accessibility: keyboard navigation, focus states, labels/ARIA, contrast.
9. Tests appropriate to the risk pass locally and in CI (unit; integration for DB/authz; E2E for critical journeys).
10. Documentation updated (README/ARCHITECTURE/SECURITY/ADRs/env vars/API docs as applicable).
11. No secrets, credentials or personal data in code, logs, fixtures or commits.
12. Database changes use versioned Prisma migrations; destructive ones have explicit human approval and a rollback plan.
13. CI is green (`format:check`, `lint`, `typecheck`, `test`, `build`).
14. Changes were reviewed and merged through a pull request; the PR lists the checks actually run.

## Phase level

A roadmap phase is done when every issue in it meets the above **and** the phase's acceptance
criteria in [`ROADMAP.md`](ROADMAP.md) are demonstrated (with evidence in the phase PR/issue), and
remaining gaps are filed as issues rather than silently dropped.

## Never

- Mark work complete when tests were not executed.
- Ship LLM-generated numbers as metrics (metrics come from deterministic backend code).
- Present illustrative or fabricated data as real.
