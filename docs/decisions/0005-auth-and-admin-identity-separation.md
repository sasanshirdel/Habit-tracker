# ADR-0005: Customer authentication and separate administrative identity

- **Status:** Accepted (design); implementation Phase 2 (customer) and Phase 10 (admin)
- **Date:** 2026-11-24

## Context

PRD §3.11, §3.15 and §4 require: secure customer auth (email/password, verification, recovery, Google), and a **separate** administrative identity for the owner and staff with mandatory MFA, RBAC, backend authorisation on every endpoint, step-up for sensitive operations, and audit logging. The owner's customer account must never become an admin via a flag.

## Decision

1. **Two identity domains, two tables, two session types.**
   - `User` (customers) and `AdminIdentity` (staff) are separate tables with no foreign key that grants one the other's powers. Same email may exist in both, but they are unrelated principals.
   - Separate session cookies (`__Host-session` vs `__Host-admin_session`), separate session tables, different lifetimes (admin: short idle timeout, absolute max lifetime).
2. **Sessions, not long-lived JWTs, for browsers:** opaque random session IDs stored hashed server-side, `HttpOnly; Secure; SameSite=Lax` (admin: `Strict`), rotated on login/privilege change, revocable. CSRF protection for cookie-authenticated state-changing requests.
3. **Passwords:** Argon2id with tuned parameters; breached-password check considered in Phase 2; rate-limit + progressive lockout on login, recovery and MFA endpoints.
4. **Admin surface isolation:** separate Next.js app (`apps/admin`, Phase 10) on its own origin/subdomain, and admin API routes under `/api/v1/admin/*` guarded by an `AdminAuthGuard` + `PermissionGuard`. Customer guards never accept admin sessions and vice versa.
5. **MFA:** mandatory for every admin identity. Owner: passkey/WebAuthn required (phishing-resistant), TOTP + one-time recovery codes as fallback. Customers: optional TOTP/passkeys later.
6. **RBAC:** roles Owner, Super Admin, Billing Admin, Support Admin, Content Admin, Read-Only Analyst map to fine-grained permissions (`billing.refund.create`, …). Checks are server-side; the frontend only hides UI.
7. **Step-up re-authentication** (fresh WebAuthn/TOTP within N minutes) for the PRD §4.5 list of sensitive operations.
8. **Audit log:** append-only table (no UPDATE/DELETE grants for the app role), actor, action, target, before/after metadata (redacted), request context, outcome.
9. **Owner bootstrap — no default credentials, ever.** The first Owner is created by a one-time CLI command run by the operator on the server (`pnpm --filter @habit/api admin:bootstrap-owner --email ...`), which: refuses to run if any Owner exists; issues a single-use, short-lived enrolment link/token printed to the operator's terminal only; forces password + passkey/TOTP enrolment on first use; writes an audit record. No seed file, migration or env var contains an admin password.

## Consequences

- More code than a role flag on `User`, but the PRD's separation requirement is met structurally rather than by convention.
- Support access to customer data uses purpose-bound, time-limited, audited grants (Phase 10), not blanket admin read access.
