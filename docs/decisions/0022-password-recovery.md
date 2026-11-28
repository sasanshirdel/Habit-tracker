# ADR-0022: Password recovery

- **Status:** Accepted (P2-05)
- **Date:** 2026-11-27

## Context

PRD §3.11 requires password recovery; SECURITY §5 requires rate limiting on recovery endpoints
and generic answers (no account enumeration). Backlog P2-05 (#25): "Forgot/reset password with
single-use expiring tokens and session revocation" — request without enumeration, reset with a
token that revokes the other sessions, a notification email when the password changes; tokens
hashed, endpoints rate-limited; an end-to-end reset test. ADR-0017 created the `password_reset`
token purpose and the `password_changed` session revocation reason; ADR-0021 built the mail port,
the `email` queue, the fragment-link pattern and `INVALID_TOKEN`, and said P2-05 would reuse
them. The web reset page is part of the auth UI issue #29 (P2-09).

## Decision

### Request: `POST /api/v1/auth/password-reset/request`

- `@Public()` (exact-origin check, ADR-0019), rate-limit class `auth` (10 per 5 minutes per
  client address, fails closed). Body `{ email }`, normalised by the shared
  `passwordResetRequestSchema` (trim + lower-case, like sign-in).
- **Answers 202 `{ status: 'accepted' }` before doing anything that depends on the address.** The
  handler validates the body and returns; `PasswordRecoveryService.requestReset` then runs in the
  background (not awaited by the request; awaited on shutdown):
  1. a **per-address limit** — one email per minute and five per hour — keyed by a truncated
     SHA-256 of the address (the login-lockout key, never the address), counted for every
     submitted address, registered or not, and failing **closed** (no email without Redis);
  2. the account lookup (`deleted_at IS NULL`);
  3. queueing `identity.password-reset-email` with `{ userId }` only.

  So the response body, status, headers and timing are the same for a registered, unknown,
  deleted or throttled address; failures in the background are logged without personal data and
  never reach the client. The per-address limit never shows as a 429 (that would itself be a
  signal); the `auth` class still does.

- Why not the registration approach (ADR-0018: same work on every path)? Registration hashes a
  password on every path anyway; here the only address-dependent work is a lookup and an enqueue,
  and doing it after the response removes the timing difference entirely instead of padding it.

### Worker jobs (queue `email`, 5 attempts, exponential backoff from 2 s)

- `identity.password-reset-email` `{ userId }`: missing or deleted account → nothing; otherwise
  issue a token and email `{WEB_APP_URL}/{locale}/auth/reset-password#token=<token>` in the
  account's language (template `identity.password-reset`).
- `identity.password-changed-email` `{ userId }`: "your password was changed; every device was
  signed out; if this wasn't you, reset it again" with a sign-in link, no token (template
  `identity.password-changed`). Queued after a successful reset with the job id
  `identity-password-changed-<token row id>`, so a retried request cannot send it twice.

### Tokens (`PasswordResetService`, `user_tokens.purpose = password_reset`)

Same storage as verification tokens (ADR-0017/0021): 256-bit random, only the SHA-256 stored,
the address it was sent to in `user_tokens.email`.

- **30 minutes** (`PASSWORD_RESET_LINK_MINUTES` in `@habit/shared-validation`, shared with the
  page's copy), **single use**, valid only while `user_tokens.email` equals `users.email` and the
  account is not deleted.
- **Newest link only:** issuing deletes the user's unused reset tokens.
- Unknown, malformed, expired, used, superseded, wrong-address and deleted-account tokens are
  indistinguishable: 400 `INVALID_TOKEN`.

### Reset: `POST /api/v1/auth/password-reset/confirm`

- `@Public()` (origin check), class `auth`. Body `{ token, password }`; the password is checked by
  the same `newPasswordSchema` as registration (8–128 code points after NFKC) — a violation is
  400 `VALIDATION_FAILED` and **leaves the link usable**.
- The Argon2id hash is computed only after a cheap read says the token is usable (no free
  CPU-burn endpoint for dead links); then **one transaction** re-checks and consumes the token
  with a conditional update (of concurrent resets exactly one wins), stores the new hash
  (creating the credential when the account had none, e.g. a future Google-only account), revokes
  **every** open session of the account (`revoked_reason = password_changed`), deletes the other
  unused reset tokens and — see below — marks the address verified and deletes unused
  verification tokens.
- After the commit: the per-address **sign-in lockout is cleared** (the owner just proved control
  of the address) and the "password changed" notice is queued. Both are best effort: a failure is
  logged and the reset stands.
- **No automatic sign-in.** 200 `{ status: 'password-reset' }`, no cookie. The user signs in with
  the new password on the next screen. Reasons: the link may be opened on a device the user does
  not want to stay signed in on; sign-in keeps one path (with its lockout and rotation); and "all
  sessions end" stays literally true.
- **The address counts as verified** after a reset: the token was delivered to that address and
  is bound to it, which is exactly what the verification link proves (ADR-0021). Leaving it
  unverified would ask the user to prove the same thing twice.

### Web (part of #29)

- `/{locale}/auth/forgot-password`: email field (shared schema), "Send reset link"; the
  confirmation is worded for both cases ("If {email} belongs to an account, we've sent it a link
  … works for 30 minutes …"), heading focused. Linked from the sign-in page ("Forgot your
  password?").
- `/{locale}/auth/reset-password#token=…` (noindex): reads the token from the fragment once,
  removes it from the address bar, keeps it in memory; shows "New password" + "Repeat new password"
  (shared policy; equality checked after NFKC in the browser only); posts only when the user
  presses **Change password** (opening the link changes nothing). Result states "Password changed"
  (→ Sign in) and "This link doesn't work" (→ Ask for a new link), headings focused; network and
  rate-limit errors keep the form. Afterwards the cached session is re-checked.
- Logical CSS only, fa/en messages with identical keys, Persian digits via ICU `number`.
- All auth forms (sign-in, sign-up, forgot, reset) now re-validate **on change** after a failed
  submit instead of on blur: a field message that disappeared on blur moved the submit button
  between mouse-down and mouse-up, so the click was lost (found by the browser suite).

### No new dependency, no migration

Everything reuses ADR-0017/0018/0021 building blocks. The per-account email throttle of ADR-0021
(`RESEND_THROTTLE_STORE`) became a small generic "email send limits" store (`take(key, limits)`;
same Redis keys for verification as before).

## Alternatives considered

- **Await the lookup and enqueue in the request** (constant work instead of background work) —
  still leaks a Redis round trip for registered addresses; padding to a fixed latency is fragile.
- **429 for the per-address limit** — reveals that the address was asked for recently (by someone)
  and lets a third party probe that state; silent drop + neutral copy instead.
- **Token in the job payload / address in the payload** — forbidden by the queue payload rule
  (SECURITY.md); the worker issues the token.
- **Reset link opens a page that resets on GET** — mail scanners would consume it; fragment +
  button press, as ADR-0021.
- **Sign in automatically after the reset** — possible later (it would be a sign-in with rotation
  and the CSRF token in the body); not needed for the flow and less conservative.
- **Keep other sessions** — the backlog requires revocation; a reset usually means the password
  may be known to someone else.
- **Longer lifetime (e.g. 1–2 h) or allowing older links** — more forgiving for slow mail, but a
  longer-lived credential; 30 minutes and newest-only are common defaults (OWASP Forgot Password
  Cheat Sheet).

## Open decisions (interim choices, reversible; for the owner)

1. **Link lifetime 30 minutes**, newest link only; per-address limit 1/min and 5/h.
2. **No automatic sign-in** after a reset.
3. **A reset marks the address verified.**
4. **Notification email** on every password change (sent; it cannot be turned off).
5. Like all email: **no real provider yet** (ROADMAP #12) — links only reach the log or the local
   outbox.

## Consequences

- Two new public routes (reviewed in the route inventory), two worker jobs, two email templates,
  shared schemas and contracts; no new error code (reuses `INVALID_TOKEN`, `VALIDATION_FAILED`,
  `RATE_LIMITED`).
- Tested on real PostgreSQL/Redis with a real worker (journey, sessions revoked with
  `password_changed`, unknown/deleted addresses get nothing, per-address limit, newest link only,
  expiry, address change, deleted account, concurrent use, lockout cleared, password-less account,
  no secrets in logs) and in Chromium (en desktop journey with a second signed-in device; fa phone
  neutral confirmation and dead link).
- Follow-ups: changing the password while signed in (settings, P2-07/P2-09) should reuse the
  revocation and the notice; security events for password changes (P2-08); the expired-token
  clean-up job named in ADR-0021 covers reset tokens too.
