# ADR-0025: Data export and account deletion

- **Status:** Accepted (P2-10)
- **Date:** 2026-11-27

## Context

Backlog P2-10 (#30): users download their data and delete their account, with re-authentication,
a grace period, a hard-delete job and documented retention (PRD §3.11 "Data export", "Account
deletion"; §17 data ownership, data minimisation, retention policies; §4.5 step-up for "deleting
critical data"; §6 "use soft deletion where appropriate"). ADR-0017 created `users.deleted_at` and
holds the email address of a soft-deleted account (open decision 1: the window length and what
happens after it belong to P2-10). Today the user-owned data is the identity module's: account,
profile, preferences, sessions, security events, emailed-link tokens. Habits, goals, tasks,
journal and more arrive from Phase 3 on and must be covered without revisiting this design. There
is no object storage yet (ROADMAP #3) and no scheduled-job infrastructure (ADR-0023).

## Decision

### Data export — synchronous JSON, built from a module registry

- `POST /api/v1/account/export` returns one JSON document (`UserDataExport` in
  `@habit/shared-types`): `{ format: "habit-tracker.user-data-export", version: 1, exportedAt,
sections: { <module>: … } }`, with `Content-Disposition: attachment;
filename="habit-tracker-data-YYYY-MM-DD.json"` and the API's `Cache-Control: no-store`.
- **Registry:** platform area `apps/api/src/data-export/` (`DataExportModule`, `@Global`, imported
  by `AppModule`) holds `UserDataExportRegistry` and `UserDataExportService`. Each feature module
  registers one `UserDataContributor` in `onModuleInit`: a section name, the **tables** it owns
  with user rows mapped to `included` or `{ excluded: reason }`, and `collect(tx, userId)`. The
  platform never imports a module (ADR-0016); modules import the platform. Platform code gets the
  transaction type from `database/` (`DatabaseTransaction`), so the generated client stays where
  ADR-0016 allows it.
- **Consistent snapshot:** all contributors run in one `REPEATABLE READ`, `READ ONLY` transaction
  (15 s timeout).
- **Completeness is tested:** an integration test reads every foreign key to `users` from the
  catalog and fails unless the registry accounts for exactly those tables (plus `users`) — a new
  table without an export decision fails CI — and that every such key is `ON DELETE CASCADE`
  (needed by the purge, below).
- **Identity section (`account`):** `user` (id, email, verified/created/updated), `password`
  (`set`, `changedAt` — never the hash; `user_password_credentials` is the one excluded table),
  `profile`, `preferences`, `sessions` (all stored rows incl. ended ones within their retention,
  coarse client only — never the token hash), `securityEvents`, `emailLinks` (purpose, address,
  dates — never the token hash).
- **Why synchronous (for now):** the data is kilobytes (a few hundred rows at most); answering the
  request directly means nothing is stored, so there is no archive to protect, expire and purge, no
  "short-lived link" that could leak, and no object store (undecided, ROADMAP #3). The issue's
  "export job producing a downloadable archive (expiring link)" is the target once data volume
  needs it: the registry is the seam — a worker job would call the same `UserDataExportService`,
  write the file to private object storage and email a short-lived signed link. Revisit when a
  section can exceed ~1 MB or ~2 s (journal, Phase 5) or when CSV is required (the issue says
  JSON/CSV; JSON only for now — CSV per table is a later addition from the same sections).
- **Protection:** signed in, CSRF (a `POST`, so no link, prefetch or other site can trigger it),
  rate-limit class `sensitive` (new: 10 per hour per user, fails closed), owner-only (no id in
  the URL). Recorded as a `data_exported` security event (after the snapshot, so it appears in the
  next export). The document is never logged, cached or stored; the access log has the route
  pattern and status only (tested).
- **Web:** the API is on another origin and needs the CSRF header, so the page fetches the
  document and saves it with an object URL (`saveJsonFile`), revoked afterwards.

### Account deletion — re-authentication, soft delete, grace period

- `POST /api/v1/account/deletion` `{ password }`:
  1. **Re-authentication** (PRD §4.5): one Argon2id verification of the current password.
     Wrong → **403 `REAUTHENTICATION_FAILED`** (new error code; not 401, the session itself is
     valid). Failures count towards the per-address sign-in lockout (ADR-0018), on top of the
     `sensitive` class, so a stolen session cannot guess faster here than at sign-in. An account
     without a password (Google sign-in, P2-06) cannot re-authenticate this way yet — P2-06 must
     add a re-authentication path (e.g. fresh Google sign-in) before such accounts exist.
  2. **One transaction:** `users.deleted_at = now` (only if not already set), **every** session
     revoked with `account_deleted`, every unused emailed link (verification, reset, restore)
     deleted, `account_deletion_requested` security event recorded.
  3. **After commit:** the cookie is cleared (202 `{ status: "deletion-scheduled", purgeAfter }`)
     and `identity.account-deleted-email` `{ userId }` is queued (best effort; a queue outage is
     logged without personal data and does not undo the deletion — see open decisions).
- From then on the account does not exist for every path that already filtered on `deleted_at`
  (sign-in → 401 `INVALID_CREDENTIALS` like an unknown address, sessions, password reset — no
  email, verification). The address stays **reserved** (ADR-0017): registering it again answers
  the usual 202 and changes nothing.
- **Grace period: 30 days** (interim, `ACCOUNT_DELETION_GRACE_DAYS` in `@habit/shared-types`, used
  by API, worker, email and web). Long enough to notice a mistake or an attacker's deletion after a
  holiday, short enough to honour "erase" requests promptly (GDPR's one-month response window);
  common practice for consumer accounts.
- **Typed confirmation** (web only): the dialog needs the password and the account's email address
  typed out (`deletionConfirmationMatches`, trimmed, case-insensitive) — language-neutral and
  deliberate. The server's check is the password.

### Restore — by emailed link, within the grace period

- The worker handler issues a restore token (new `user_token_purpose` `account_restore`; 256-bit,
  SHA-256 stored, newest only, **expires at the purge time**) and emails the confirmation with
  `…/{locale}/auth/restore-account#token=…` and the purge date in the account's language, time
  zone and calendar (P2-07). Token in the fragment, confirmed by a button (ADR-0021 pattern).
- `POST /api/v1/auth/account-restore` `{ token }` (public, origin-checked, class `auth`): one
  transaction consumes the token, clears `deleted_at` only if the grace period has not passed
  (a purge that has not run yet does not extend it) and records `account_restored`. Every failure is
  400 `INVALID_TOKEN`. **No automatic sign-in**; sessions ended at deletion stay ended.
- Why an emailed link rather than "sign in to restore": the owner may have deleted the account
  because the password was compromised; the link proves control of the address, needs no new
  sign-in path for deleted accounts and does not reveal deletion to someone who only knows the
  password. Admin-side restore (PRD admin "Restore accounts") arrives with Phase 10.

### Purge — hard delete after the grace period

- `AccountPurgeService.purgeExpired(now, batchSize = 100)` deletes `users` rows whose
  `deleted_at ≤ now − 30 days`, in batches; each `DELETE` re-checks the condition, so an account
  restored a moment earlier survives and concurrent runs never double-count. Cascades remove every
  user-owned row (ADR-0017; enforced by the catalog test above). Logs the count only. Index
  `users(deleted_at)` (new) serves the lookup. Afterwards the address can be registered again.
- Worker job `identity.account-purge` (queue `system`, empty payload, idempotent) runs it.
- **Scheduling:** the platform has no repeatable-job scheduler yet (ADR-0023 deferred one). Until
  it exists the job must be enqueued daily by the deployment (cron calling a small script, or
  BullMQ `upsertJobScheduler` once the scheduler work lands — tracked as a follow-up together with
  ADR-0023's global retention purge). Until then deleted accounts simply stay soft-deleted (and
  unrestorable after 30 days); nothing is lost or exposed by a late purge.
  **Update (ADR-0026):** the worker now registers schedule `identity.account-purge-daily`
  (`30 23 * * *` UTC, 03:00 Tehran); nothing has to be enqueued by the deployment.

### What is not erased by the purge (documented retention)

- **Logs:** carry user ids and request ids, never addresses, names or exported content; kept per
  the deployment's log retention (ROADMAP #3).
- **Redis:** sign-in lockout and rate-limit counters (hashed address or user id) expire on their own
  (≤ 1 h); BullMQ keeps failed jobs 7 days (payload: user id only).
- **Mail:** development transports only (log/outbox); a real provider's retention is part of
  ROADMAP #12.
- **Backups:** a deleted account remains in backups until they rotate (backup policy: Phase 12).

### Migration

`20261127150000_account_deletion`: three `security_event_type` values (`data_exported`,
`account_deletion_requested`, `account_restored`), one `user_token_purpose` value
(`account_restore`), index `users_deleted_at_idx`. Additive only (unit-tested), deployed from the
previous migration state by the generic upgrade test. Rollback before real data: drop the index
(enum values cannot be removed; harmless unused).

## Alternatives considered

- **Async export job + stored archive + emailed link now** — matches the issue text, but needs an
  object store (undecided) or storing a full copy of personal data in PostgreSQL/Redis with its own
  expiry and purge, for kilobytes of data. Deferred behind the registry (see above).
- **`GET /account/export` as a plain link** — simplest download, but a GET has no CSRF token and the
  session cookie is on the API's origin; any page could make the browser download (harmless to
  read, but noisy and recorded as an event). POST + CSRF chosen.
- **Immediate hard delete** — irreversible on a mistake or a hijacked session. Rejected.
- **Restore by signing in during the grace period** — reveals deletion to anyone with the password
  and needs a special sign-in path for deleted accounts. Rejected for the emailed link.
- **401 `INVALID_CREDENTIALS` for a wrong deletion password** — the web client treats 401 as
  "session ended"; a distinct 403 code keeps the user signed in and the message precise.
- **Releasing the email address at deletion** — would let someone re-register it while the old
  account is restorable (takeover of a restorable identity). Kept reserved (ADR-0017).

## Open decisions (interim choices, reversible; for the owner)

1. **Grace period length:** 30 days.
2. **Export format and delivery:** synchronous JSON download; no CSV; async + expiring link when
   data grows (needs ROADMAP #3).
3. **Purge scheduling:** ~~job exists, no scheduler — the deployment must enqueue
   `identity.account-purge` daily until the platform scheduler lands.~~ Resolved by ADR-0026: runs
   daily at 23:30 UTC from a BullMQ job scheduler the worker registers (time is interim).
4. **Lost confirmation email:** if the email job cannot be queued, the user has no restore link
   (support/admin restore arrives in Phase 10). Option: a "send me a restore link" form.
5. **"Account restored" notice email:** not sent (the restorer proved control of the address).
6. **Export rate limit:** 10 per hour per user (`sensitive`, shared with deletion attempts).

## Consequences

- Every new module with user rows must register a contributor (or state an exclusion) and reference
  `users(id)` with `ON DELETE CASCADE`; CI fails otherwise.
- Deleted accounts consume their address for 30 days plus the time until the next purge.
- `REAUTHENTICATION_FAILED` is the error for every future step-up confirmation (email change,
  password change from settings).
