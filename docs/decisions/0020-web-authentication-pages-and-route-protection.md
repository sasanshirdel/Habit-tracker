# ADR-0020: Web authentication pages and client-side route protection

- **Status:** Accepted (P2-09, first part)
- **Date:** 2026-11-26

## Context

P2-02 (ADR-0018) shipped `POST /auth/register` (202 for any address), `POST /auth/login`
(`INVALID_CREDENTIALS` for unknown address and wrong password alike, progressive per-address
lockout `policy: "login-account"`) and `POST /auth/logout`; P2-03 (ADR-0019) made the API deny by
default, added two-layer CSRF and `GET /auth/session`, and left **open decision 1**: the `(app)`
pages cannot check the session on the Next.js server, because the `__Host-session` cookie is
host-only on the API's origin (web and API are different origins, ADR-0011/0015). Backlog P2-09
(#29) asks for accessible, localized auth screens built with React Hook Form and the shared zod
schemas, all states, RTL, no credentials in client storage and correct `autocomplete` attributes.
ROADMAP decision #10 (landing vs. dashboard at `/{locale}`) was deferred to this item.

Scope of this ADR (the parts whose API exists): sign-up, sign-in, sign-out and page protection.
Email verification (P2-04), password recovery (P2-05) and settings/sessions pages (P2-07/P2-08)
add their pages on this foundation when their endpoints land.

## Decision

### Pages and routes

- `/{locale}/auth/sign-in` and `/{locale}/auth/sign-up` (the `/{locale}/auth/*` prefix of
  ARCHITECTURE §7), in `app/[locale]/auth` with their own layout (brand → landing page, language
  and theme switchers, one centred card; logical CSS only). `/{locale}/auth` itself is a 404.
- **Landing vs. app (ROADMAP #10) — interim, reversible:** nothing moves. The landing page stays at
  `/{locale}`, Overview at `/{locale}/overview` (`appHomeHref`, one constant). The landing page's
  "Open the app" became **Create an account** / **Sign in**; a signed-in visitor who opens the
  sign-in page is sent straight on to the app. The public landing page makes no session call (no
  API traffic and no 401 noise for every visitor). Swapping later (dashboard at `/{locale}`) is a
  change of `appHomeHref`, the landing route and its tests — no data or API change.

### Forms

- **React Hook Form 7.92.0** (ADR-0001 addendum) with a 25-line in-repo `schemaResolver` over the
  **shared** schemas `signInCredentialsSchema` / `signUpCredentialsSchema`
  (`@habit/shared-validation`), which the API's `loginBodySchema` / `registerBodySchema` are now
  built from — one definition of what the server accepts (a test asserts both accept the same
  inputs). The resolver maps each field's first zod issue **code** to a localized message; the
  schema's English text is never shown, and the submitted values are the schema's output (trimmed,
  lower-cased email; NFKC password), exactly what the API normalises to. The server stays the
  authority.
- Validation on submit, re-validation on blur; `noValidate` (consistent localized messages instead
  of the browser's); focus moves to the first invalid field.
- **Accessibility:** every field has a `<label for>`; errors are linked with `aria-describedby` and
  flagged `aria-invalid`; the password rule (sign-up) is persistent help text linked the same way;
  form-level errors use an `Alert` (`role="alert"`); the 202 confirmation's heading receives focus;
  the submit button keeps focus while busy (`aria-disabled`, not `disabled`) and a second submit
  is ignored. New `@habit/ui` primitives: `Label`, `PasswordInput` (show/hide toggle: a real
  button with a constant name "Show password" and `aria-pressed`, `aria-controls`; the whole
  control is LTR so the toggle sits at the end of the text in RTL pages too), `Alert`.
- **Autocomplete / input hints:** sign-in `email` field `type="email" autocomplete="username"`
  (pairs with the password for password managers), password `current-password`; sign-up
  `autocomplete="email"` and `new-password`. Email and password are `dir="ltr"`, no
  auto-capitalisation/correction/spell-check; `inputMode="email"`.
- **Messages (no enumeration):** `INVALID_CREDENTIALS` → one message for both causes; after a
  failure the password is cleared and focused. `RATE_LIMITED` with `policy: "login-account"` →
  "Too many unsuccessful sign-in attempts … wait N minutes" (also shown for addresses without an
  account — the API locks any submitted address); other `RATE_LIMITED` (per-device `auth` class) →
  "Too many attempts from this device … wait N minutes"; both from `retryAfterSeconds`.
  `VALIDATION_FAILED` → a generic "check what you entered"; anything else → the app-wide
  `apiErrors.<CODE>` text. Sign-up's 202 shows a neutral confirmation: "If this email address isn't
  registered yet, your account is ready. Sign in …" — true for both cases, no sign-in. **P2-04
  changes this copy to "check your email"** when verification mail exists. _(Done in P2-04,
  ADR-0021.)_
- Sign-up sends the page's locale (language preference) and the browser's IANA time zone
  (validated with the API's `timeZoneSchema`, `UTC` fallback).
- Full `auth.*` catalogues in `en.json` and `fa.json` (parity enforced); numbers in Persian copy
  use Persian digits (`{min, number}`).

### Session state and route protection (closes ADR-0019 open decision 1 with option (a))

- `useSession()` (`lib/auth/session.ts`): TanStack Query on `GET /auth/session` (reused for 60 s,
  re-checked on focus). 200 → signed in, and the response's CSRF token goes to the in-memory store
  (`csrfTokens.remember`); 401 → signed out (token `null`); any other failure → an **error**, not
  "signed out".
- `AuthGate` wraps the content of every `(app)` page. It renders the page **only after** the
  session check said "signed in". Before that — and always in the server HTML, where the session is
  unknowable — it shows a neutral placeholder (`aria-busy`, "Checking your session…" as a status
  for screen readers). Signed out → `router.replace` to `/auth/sign-in?next=<this page>`; after an
  explicit sign-out, without `next`. A failed check shows the error with a retry, never a redirect
  loop. The shell chrome (navigation, switchers) is public and still server-rendered; the account
  menu appears once the session is known.
- **This is UX, not a security boundary.** Page components (server-rendered and in the RSC
  payload) must never contain user data; user data comes only from the API, which authorizes every
  request (deny by default, P2-03). Reviewers should reject a server component that reads user
  data for an `(app)` page while this ADR holds.
- **Sign-in** posts through a CSRF-less client (`publicApi`: login/register never look at a
  session, so no token is needed and no `GET /auth/session` is spent per attempt), keeps the
  returned CSRF token in memory, drops every cached query of the previous principal and writes
  the new session into the cache, then navigates to `next` or `appHomeHref`.
- **Sign-out** (`AccountMenu` in the banner → "Sign out"): `POST /auth/logout` with the in-memory
  CSRF token; only after the API confirms are cached queries and the token dropped (another user
  of the device must not see this user's data); a failure keeps the user signed in and says so.
  Sign-out everywhere stays an API feature until the sessions page (P2-08).
- No credentials or tokens in `localStorage`, `sessionStorage`, readable cookies or logs (tests
  assert it).

### `next` and open redirects

`safeNextPath()` (`lib/auth/redirect.ts`) honours `next` only when it is a path **inside the app**:
≤ 512 characters; no whitespace, control characters or backslashes (browsers strip tab/newline
from URLs, `/\evil` is `//evil` to URL parsers); exactly one leading `/`; same origin after WHATWG
URL parsing; and the path is one of the app's sections or below one (an allow-list — not even our
own auth pages or `/status` qualify). A leading locale segment is dropped. Everything else falls
back to `appHomeHref`. Applied on the server when the page reads `?next=` and again when building
links and redirects. Tested with unit cases, HTTP route tests and in the browser.

### Zod in the browser

The web bundle now contains zod (the shared schemas). zod 4 probes `new Function` when it builds
object schemas; the CSP has no `'unsafe-eval'`, and the probe — although caught — is reported as
a `securitypolicyviolation`. `@habit/shared-validation` sets `z.config({ jitless: true })` when a
`document` exists, before any schema is built (`src/zod-config.ts`, imported first). Same parsing
results; the API keeps zod's JIT.

### Browser suite (ADR-0015)

- A `setup` project signs one shared account in and saves `storageState`; the `chromium` project
  starts signed in. Tests that sign in or out use their own accounts with an empty state (signing
  in revokes the presented session; signing out ends it).
- The API's `auth` class (10 per 5 min per address) applies to the whole suite from 127.0.0.1, so
  each run gets its own rate-limit prefix and the suite has a documented budget
  (`E2E_AUTH_BUDGET` = 9 today). The limiter is **not** disabled. _(Superseded in P2-04,
  ADR-0021: per-test client addresses instead of a suite-wide budget.)_
- Chromium logs every 401 as a console error; tests on signed-out pages declare exactly that
  message as expected (`expectedConsoleErrors`), everything else still fails the test.

## Alternatives considered

- **Server-side protection** (ADR-0019 option (b)): serve the API under the web origin (reverse
  proxy for `/api/v1`), then the `(app)` layout can forward the cookie and redirect before any
  HTML. Better UX (no placeholder) and a real server-side check, but it is a deployment decision
  (P12, ROADMAP #3). Revisit then; the gate is then replaced by a layout check without changing
  the pages.
- **A readable "signed-in" hint cookie on the web origin** (set by the web after sign-in) to let
  the server guess — still not authoritative, can go stale, adds a cookie to keep in sync.
  Rejected.
- **Hiding the whole shell until the check** — removes navigation chrome that contains no user
  data and makes every app load look blank; rejected in favour of gating page content only.
- **`@hookform/resolvers` 7.0.9** (2026-11-24): would work with zod 4, but declares ~20 optional
  peer dependencies and pulls `@standard-schema/utils`; our resolver is 25 lines and typed
  structurally (no direct `zod` dependency in `apps/web`). Revisit if forms need more than
  "first issue per field".
- **No form library** (plain controlled inputs): fine for two forms, but the backlog chose RHF
  (ADR-0001 deferred list) and later forms (habit editor, schedules) need field arrays and
  dirty/touched state; adding it now with the simple forms keeps one pattern.
- **Redirecting signed-in visitors away from `/{locale}`** — needs a session call from the public
  landing page for every visitor; deferred with ROADMAP #10.

## Consequences

- New dependency `react-hook-form` 7.92.0 (web). No API, env var, table or migration change; the
  API's register/login schemas are rebuilt from the shared ones with identical behaviour (OpenAPI
  unchanged).
- Every `(app)` page now waits for one `GET /auth/session` (cached for the tab) before showing
  content; route tests assert the server HTML holds only the placeholder.
- Open for the owner: ROADMAP #10 (still interim), the 202 copy until P2-04, and option (b) with
  the deployment decision.
- Follow-ups: verify/reset pages (P2-04/P2-05 — _done: verify-email in ADR-0021,
  forgot-password/reset-password in ADR-0022_), settings and sessions pages with "sign out
  everywhere" (P2-07/P2-08 — _done: ADR-0023, ADR-0024, ADR-0025_), reacting to a 401 from any
  API call by re-checking the session, field-level mapping of server `VALIDATION_FAILED` details
  (_both done in ADR-0027_).
