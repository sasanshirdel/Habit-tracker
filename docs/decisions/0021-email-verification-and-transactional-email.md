# ADR-0021: Email verification and the transactional email foundation

- **Status:** Accepted (P2-04)
- **Date:** 2026-11-26

## Context

PRD §3.11 requires email verification, §3.12 localized email templates, §5/§7 integrations as
independent adapters ("email providers"). ADR-0017 created `user_tokens` (purpose
`email_verification`, SHA-256 of a 256-bit token, the verified address in `email`); ADR-0018 left
registration answering 202 for every address and promised that P2-04 would email the real owner of
a taken address; ADR-0020 shipped a neutral "request received" sign-up confirmation to be changed
to "check your email". SECURITY §7 forbids personal data and tokens in job payloads and logs.
Backlog P2-04 (#24): an email adapter interface with a development implementation, single-use
expiring verification tokens, fa/en templates, "unverified users are limited per policy",
integration tests with a fake transport. The owner has not chosen a product name, domain or email
provider (ROADMAP decisions #2, #3), so no real provider can be configured.

## Decision

### Mail port and transports (`apps/api/src/mail`, new platform area)

- `Mailer.send(message)` takes a rendered `EmailMessage` (`to`, `subject`, `text`, `html`,
  `locale`, `template`), adds `From` (`MAIL_FROM`), a random `Message-ID` and the date, and hands
  it to the `MailTransport` behind the `MAIL_TRANSPORT` token. It refuses CR/LF in recipient or
  subject (header injection). Logged per message: template, locale, transport, message id — never
  the recipient, subject, body or links. Delivery errors log the error class and are rethrown so
  the job retries.
- Transports, **development/test only**: `log` (default — delivers nothing, one redacted line),
  `outbox` (writes each message as a JSON file, mode 0600 in a 0700 directory, never overwriting,
  to `MAIL_OUTBOX_DIR` — used by developers and by the browser suite to open links), `memory`
  (tests). No SMTP client and no provider SDK. `MAIL_TRANSPORT=outbox` with
  `NODE_ENV=production` is allowed (the browser suite runs production builds) but logs a warning
  at start-up; it must never be used for real users.
- Rendering (`renderEmail`): one accessible, single-column, table-based layout (email clients),
  `<html lang dir>` per locale (`rtl` for Persian, Vazirmatn/Tahoma font stack, right-aligned),
  a plain-text alternative always included, a visually hidden preheader. Templates pass **plain
  strings**; every one is HTML-escaped by the renderer, so copy can never inject markup. Links must
  be absolute `https:` URLs (`http:` only on loopback hosts); the raw fallback link is `dir="ltr"`.
  Colours in the email HTML are inline literals (email clients ignore our CSS tokens); the web
  "tokens only" rule does not apply to emails.
- **Where mail is sent:** only in the **worker**. Emails are BullMQ jobs on a new `email` queue
  (so a backlog of other work never delays a sign-up link). The worker environment gains
  `MAIL_TRANSPORT`, `MAIL_OUTBOX_DIR`, `MAIL_FROM` (placeholder sender on `localhost`) and
  `WEB_APP_URL` (origin the links point to; https except loopback, origin only). The API process has no mail configuration.
- Architecture: `mail` is a platform area (it never imports feature modules); the identity module
  imports it. The worker composes the identity module's `IdentityJobsModule` (ARCHITECTURE §2.1).

### Verification flow

- **Job `identity.verification-email`** (queue `email`, 5 attempts, exponential backoff from 2 s):
  payload `{ userId, reason: 'registration' | 'resend' }` — no address, no token. The worker loads
  the account and decides:
  - deleted or missing → nothing;
  - not verified → issue a token and send the verification email in the account's language;
  - verified and `registration` → send a **"someone tried to create an account with your
    address"** notice (sign-in link, no token); verified and `resend` → nothing.
- **Tokens** (`EmailVerificationService`): 256-bit random, SHA-256 stored (ADR-0017), **24 h**,
  single use, bound to the address (`user_tokens.email` must still equal `users.email`). Issuing
  deletes the user's unused verification tokens (only the **newest link** works); a successful
  verification consumes the token with a conditional update in a transaction (of concurrent
  confirmations exactly one wins), sets `users.email_verified_at` (once) and deletes the rest.
  Unknown, malformed, expired, used, superseded, wrong-address and deleted-account tokens are
  indistinguishable.
- **Link:** `{WEB_APP_URL}/{locale}/auth/verify-email#token=<token>`. The token is in the URL
  **fragment**, which browsers never send to a server — it cannot appear in web/proxy access logs or
  a `Referer`. The page reads it, removes it from the address bar (`history.replaceState`), keeps
  it in memory and **posts it only when the user presses "Confirm"**: a GET never verifies, so
  mail scanners and link previews change nothing (and the confirm is a normal CSRF-checked POST).
- **Routes** (identity module):

  | Route                             | Auth                       | Rate limit                                                            | Success                      | Failure                                                     |
  | --------------------------------- | -------------------------- | --------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- |
  | `POST /auth/verification/confirm` | `@Public()` (origin check) | `default` + `auth`                                                    | 200 `{ status: 'verified' }` | 400 `INVALID_TOKEN` (every cause), 400 `VALIDATION_FAILED`  |
  | `POST /auth/verification/resend`  | signed in + CSRF token     | `default` + `auth` + per account 1/min and 5/h (`verification-email`) | 202 `{ status: 'accepted' }` | 429 `RATE_LIMITED` + `Retry-After`, 503 `QUEUE_UNAVAILABLE` |

  Confirm needs no session (the link may be opened on another device) and does not sign in.
  Resend answers 202 without sending when the address is already verified. The per-account limit
  lives in Redis under `RATE_LIMIT_PREFIX:verification-email:*` keyed by the opaque user id, fails
  closed (503), and a refused request does not count.

- **Registration** (ADR-0018) now queues `identity.verification-email` with reason
  `registration` for the account the address belongs to — the new one, or the existing one when the
  address is taken (also soft-deleted ones; the worker skips those). The response stays the same
  202 for every case. To stop the public form from flooding an inbox, the job id is
  deterministic per account and **15-minute window** (`identity-registration-email-<id>-<window>`),
  so repeated submissions in a window produce one email. A queue outage is logged (no personal
  data) and does not fail the registration — the user can sign in and ask for a new link.
- **New error codes:** `INVALID_TOKEN` (400) and `EMAIL_NOT_VERIFIED` (403), localized in the web
  app (`apiErrors.*`, en/fa).

### Unverified accounts — interim policy (reversible, flagged for the owner)

**Unverified users can sign in and use their own data.** The principal now carries
`emailVerified` (read with the session, no extra query), and `@RequireVerifiedEmail()`
(platform marker, enforced by the global `AuthGuard` after authentication and CSRF) answers
**403 `EMAIL_NOT_VERIFIED`** on routes that need a confirmed address. No route uses it yet; it is
meant for features that reach other people or rely on the address: changing the email (P2-07),
accountability invitations (P11), email notifications (P8), billing (P9). The web app shows a
reminder banner with "Send a new link" on every app page while the address is unverified.

Why not block sign-in until verified: with no real email provider configured, blocking would lock
every non-development user out; it would also need a public, address-taking resend endpoint (an
enumeration and inbox-flooding surface) and a different sign-in error for correct passwords.
Tightening later is a decorator on more routes, or one check in sign-in — no data change.

### Web

- Sign-up confirmation: **"Check your email"** naming the (normalised) address, wrapped in Unicode
  isolates so it reads correctly inside Persian text; still true for every case (verification
  link, already-registered notice), still no session.
- `/{locale}/auth/verify-email` (noindex): reading → Confirm button → "Email address confirmed"
  (Continue → sign-in, which forwards signed-in visitors) or "This link doesn't work" (expired,
  used, replaced — one message, with the way forward). Result headings receive focus; errors are
  alerts; logical CSS only.
- `VerifyEmailBanner` inside `AuthGate` for unverified accounts (not a heading — it precedes the
  page's `h1`), with per-account limit messages ("wait N minutes").

### Browser suite: per-test client addresses instead of a suite-wide auth budget

ADR-0020 capped the whole Playwright suite at 9 requests of the `auth` class (10 per 5 min per
address, all from 127.0.0.1). Verification adds more such requests. Instead of raising or
disabling the limit, the API under test trusts one proxy hop (`TRUST_PROXY=1`) and every test's
browser context adds `X-Forwarded-For: <address derived from the test id>` to API requests
(request interception, so the page's CORS behaviour is unchanged) — exactly what a load balancer
does for distinct clients. The limiter stays on with production limits; each test has its own
budget of 10 per 5 minutes. The suite now starts the built worker with `MAIL_TRANSPORT=outbox`
(file outbox under `apps/web/e2e/.outbox`, gitignored, emptied by the global setup) and reads the
links from it; the shared signed-in account is verified through its emailed link in the `setup`
project. CI builds the worker for the e2e job.

### No new dependency

Checked with `npm view` on 2026-11-26 and not added:

| Package                   | Version | Why not                                                                                                                    |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `nodemailer`              | 10.6.1  | SMTP/provider client — only needed with a real provider or a local SMTP catcher; the file outbox covers development/tests. |
| `mjml`                    | 5.4.1   | Responsive email markup compiler with a large dependency tree; two simple templates do not need it.                        |
| `@react-email/components` | 1.0.12  | React rendering for emails in the API process; adds React to the API for two templates.                                    |

Revisit with the provider decision: an SMTP or HTTP-API transport is one class implementing
`MailTransport`.

## Alternatives considered

- **Send directly from the API request** — couples sign-up latency and success to the mail server
  and loses retries; ARCHITECTURE §1 puts slow/retryable work in the worker. Rejected.
- **Token (or address) in the job payload** — would put a live credential and personal data into
  Redis and the failed-job set for 7 days. The worker issues the token itself instead.
- **Token in the query string, verified by GET** — leaks into access logs/`Referer`, and mail
  scanners that prefetch links would verify (or burn) it. Fragment + button instead.
- **Keep all earlier links valid** — more forgiving when emails cross, but several live
  credentials per account; "newest link only" is the common, safer choice.
- **Block sign-in until verified** — see the interim policy above.
- **Public resend by email address** — enumeration and inbox-flooding risk; re-submitting the
  sign-up form already re-sends (once per window), and signed-in users have the banner.
- **Persisted `EmailDeliveryRecord`** (PRD §6) — belongs to notifications (P8), which owns
  delivery status, bounces and preferences; not needed for two transactional templates.

## Open decisions (interim choices, reversible; for the owner)

1. **Unverified users may sign in** (above); which features require a verified address.
2. **Link lifetime 24 h**, newest link only; resend 1/min and 5/h per account; registration email
   at most once per account per 15 min.
3. **Email provider, sender address and product name** (ROADMAP #2/#3, new #12): until then mail is
   only logged or written to a local outbox — **no real email is sent anywhere**.
4. **"Someone tried to register" notice** for verified addresses: sent (at most once per 15 min).
   Some products stay silent instead.

## Consequences

- Sign-up → email → verify works end to end in development (outbox) and is tested on real
  PostgreSQL/Redis with a real worker, and in the browser.
- New env vars for the worker (`MAIL_*`, `WEB_APP_URL`), new queue `email`, two new error codes,
  two new routes (one public, reviewed in the route inventory), no migration.
- `RequestPrincipal`/`ActiveSession` gain `emailVerified`.
- Password recovery (P2-05) reuses the mail port, the renderer, the `email` queue, the fragment
  link pattern and `INVALID_TOKEN` — done in ADR-0022, which also generalised the resend throttle
  store into per-policy "email send limits" (same Redis keys for verification) and makes a
  successful password reset mark the address verified.
- Follow-ups: a real transport once a provider is chosen (with SPF/DKIM/DMARC on the sending
  domain), clean-up job for expired `user_tokens`, delivery records/bounces with notifications
  (P8), applying `@RequireVerifiedEmail()` as features land.
