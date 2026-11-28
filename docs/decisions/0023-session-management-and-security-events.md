# ADR-0023: Session management and customer security events

- **Status:** Accepted (P2-08)
- **Date:** 2026-11-27

## Context

Backlog P2-08 (#28): users see their active sessions ("device, last active, approx location"),
revoke one or all others, and security events are recorded (PRD §3.11 session management, §4.8
session revocation and security monitoring, §17 data minimisation and retention). ADR-0017 left
open decision 3 — no IP address or user agent on sessions until P2-08 decides what the list shows
and how long such personal data is kept. SECURITY.md §6 asks for customer security events (login,
password change, …) with a retention defined before launch.

## Decision

### What a session remembers about the client (resolves ADR-0017 open decision 3)

- At sign-in, the `User-Agent` header is reduced by in-repo code (`client-description.ts`, no
  dependency) to three **coarse families** and then discarded:
  - browser: `chrome`, `edge`, `firefox`, `safari`, `opera`, `samsung_internet`, `unknown`;
  - OS: `windows`, `macos`, `ios`, `android`, `linux`, `chromeos`, `unknown`;
  - device class: `desktop`, `mobile`, `tablet`, `unknown`.
- Stored as three enum columns on `user_sessions` (`client_browser`, `client_os`,
  `client_device`, default `unknown` — sessions from before the migration show "Unknown browser").
- **Not stored:** the raw user agent, any version, the IP address (raw, truncated or hashed) and any
  location. "Approximate location" from the issue is **deferred** (owner decision, see below): it
  needs IP geolocation (a database/dependency or a third party) and processing the address, which
  §17 data minimisation argues against until there is a concrete need.
- The description is a recognition aid only ("Chrome on Windows"), never a security signal — any
  client can send any header — and nothing authorises on it.
- "Last active" is the existing `last_used_at`, which is written at most once a minute.

### Session management API (`AccountController`, `/api/v1/account`)

All protected (deny-by-default guard), CSRF on unsafe methods, rate-limit class `default` (per
user), owner-scoped by the principal's user id; unknown, ended and other users' session ids all
answer 404 `NOT_FOUND`.

- `GET /account/sessions` — active sessions (not revoked, not expired, not idle-expired), newest
  sign-in first, cursor pagination (keyset on the UUIDv7 id), `current` on the session of the
  request.
- `DELETE /account/sessions/{id}` — revokes one session (`revoked_by_user`, a new
  `session_revocation_reason` value). The session store has no cache: the revoked session fails
  its very next request. Revoking the current session is a sign-out (`sign_out`, cookie cleared).
- `POST /account/sessions/revoke-others` — revokes every other session of the user, keeps the
  current one, returns `{ revoked }`.

### Security events (`user_security_events`, `SecurityEventService`)

- Types: `sign_in`, `sign_out`, `signed_out_everywhere`, `signed_out_other_sessions`,
  `session_revoked`, `password_reset`, `email_verified`. Each row: user, type, time and the same
  coarse client description of the request that caused it. No IP address, user agent, email,
  token or free text.
- **Written in the same transaction** as the change it records (session creation at sign-in,
  each revocation, the password-reset transaction of ADR-0022, the verification transaction of
  ADR-0021) — an event exists exactly when the change committed. Session rotation at sign-in
  (`rotated`) and the "password changed" sign-out of all sessions are covered by `sign_in` /
  `password_reset` and record nothing extra. `email_verified` is recorded only when the address
  was not verified before (a reset that also verifies the address records `password_reset` only).
- Failed sign-ins are **not** recorded per account (they are rate-limited and locked out per
  address, ADR-0018); revisit with security monitoring (Phase 10).
- `GET /account/security-events` — the user's events within the retention window, newest first,
  cursor pagination.
- These are the user's own activity log, not the append-only admin audit log of SECURITY.md §6
  (Phase 10); rows cascade with account deletion.

### Retention (interim)

- Security events: **180 days**. Ended sessions (revoked, expired or idle-expired): deleted
  **30 days** after they ended. Constants `SECURITY_EVENT_RETENTION_DAYS` and
  `ENDED_SESSION_RETENTION_DAYS` in `@habit/shared-types` (the page shows the window).
- Enforced **per account on write**: every recorded event deletes the account's events older than
  the window (index `(user_id, created_at)`), every sign-in deletes the account's sessions that
  ended more than 30 days ago; reads never return rows outside the window.
- Accounts that never sign in again keep their old rows until a global clean-up job exists — the
  platform has no scheduled (repeatable) jobs yet. Follow-up: a daily worker job deleting by the
  `created_at` / `expires_at` indexes once scheduling is built. **Update (ADR-0026):** done —
  `identity.retention-cleanup` runs daily at 23:45 UTC for every account (same predicates; also
  deletes expired emailed-link tokens).

### Web

`/{locale}/settings/security` (Settings lists it; ARCHITECTURE §7 gains `settings/security`): a
client component behind `AuthGate` — devices with icon, "Chrome on Windows" (product names in
first-strong isolates for Persian), "This device", relative last activity, sign-in time in the
browser's time zone (the profile time zone arrives with P2-07), per-device "Sign out" and "Sign
out of all other devices" each behind a confirmation dialog, toasts, loading/error/empty states,
"Show more" for both lists. TanStack Query `useInfiniteQuery`; revocations invalidate both lists.

### Migration

`20261127090000_session_metadata_security_events`: four new enum types, one new enum value, three
`NOT NULL DEFAULT 'unknown'` columns (metadata-only in PostgreSQL 11+, no rewrite), one table, two
indexes. Additive only (unit-tested), deployed from the previous migration state in the
integration suite (`identity.int.test.ts` upgrade path). Rollback before real data: drop the
table, the columns and the new types (`revoked_by_user` cannot be removed from the enum; harmless
if unused).

## Alternatives considered

- **Store the raw user agent** — easiest and most precise, but personal data we do not need; the
  coarse families answer "which device is this?" Rejected.
- **ua-parser-js / bowser** — accurate and maintained, but a dependency (and a licence/size review)
  for three coarse fields; ~40 lines of tested regexes suffice. Rejected for now.
- **Truncated (/24, /48) or hashed IP** — a hashed IP cannot be shown and a truncated one is still
  personal data with little value to the user without geolocation. Deferred with location.
- **Events in the admin audit log** — different audience, retention and protection (append-only,
  Phase 10). Kept separate.
- **A scheduled global purge now** — needs repeatable-job infrastructure (BullMQ job schedulers,
  leader election, monitoring) outside this issue's scope.

## Open decisions (interim choices, reversible; for the owner)

1. **Approximate location** of sessions: not stored or shown. Options: none (current); country
   from IP geolocation at sign-in (needs a GeoIP database/provider choice and a privacy-policy
   line); city-level.
2. **Retention**: events 180 days, ended sessions 30 days, purged per account on write and, since
   ADR-0026, daily for all accounts.
3. **Failed sign-in events** per account: not recorded.

## Consequences

- The session list is meaningful without storing IP addresses or user agents; recognising a
  device is coarse by design (two Chrome-on-Windows machines look the same).
- Every new security-relevant action (password change from settings, email change, Google
  linking, MFA) must add an event type (enum migration + shared constant + messages) and record it
  in its transaction.
- A global retention job is owed once scheduled jobs exist (delivered by ADR-0026).
