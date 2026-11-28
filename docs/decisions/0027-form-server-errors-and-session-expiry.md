# ADR-0027: Server validation errors on form fields, and session expiry in the web client

- **Status:** Accepted
- **Date:** 2026-11-28

## Context

P2-09 (#29) left two follow-ups after the auth and settings pages landed (ADR-0020, ADR-0021,
ADR-0022, ADR-0024, ADR-0025):

1. **Server validation errors.** Every form validates with the API's own shared zod schemas before
   sending (ADR-0020), so the API rarely answers `400 VALIDATION_FAILED` — but it stays the
   authority. It can refuse what the browser accepted: an IANA zone the server's ICU data lacks, a
   normalisation difference, a client older than the API, a request changed in flight. Until now
   the forms showed a generic form-level message ("Some of the information you entered is not
   valid") and left the user to guess which field. The envelope already carries field-level
   details (ADR-0009): `details.issues[]` with `field` (`body.<path>`), a zod issue `code` and an
   English developer `message`.
2. **Session ended under an open page.** `AuthGate` (ADR-0020) checks `GET /auth/session` when a
   page opens and every 60 s / on focus. A session can end in between — idle or absolute expiry
   (ADR-0018), sign-out on another device (ADR-0023), a password reset (ADR-0022) — and the next
   request answers 401 `UNAUTHENTICATED`. The page showed that as an ordinary error, and stale user
   data stayed in the query cache.

## Decision

**Field errors from the server (`apps/web/lib/forms/server-errors.ts`).**

- `validationIssuesOf(error)` reads `details.issues` of a `VALIDATION_FAILED` `ApiError` (malformed
  entries dropped). `serverFieldErrors(error, fields, rename?)` matches `body.<field>` (and nested
  `body.<field>.…`) to the form's fields **in the form's visual order**, first issue per field.
  `applyServerFieldErrors(error, { setError, setFocus }, fields)` sets each React Hook Form error
  with `type = issue code` — the same shape `schemaResolver` produces client-side — and focuses the
  first invalid field.
- Every form therefore shows a server error with its **existing** localized messages,
  `aria-invalid` and `aria-describedby`, in fa and en. The API's English `message` is never shown.
- When at least one field took an error there is **no form-level alert** (like a client-side
  validation failure). Issues on parts of the request that are not fields of the form — a hidden
  locale or time zone on sign-up, an unknown key, `query`/`params` — keep the form-level message.
  The mark clears when the field is edited (`reValidateMode: 'onChange'` re-runs the shared
  schema).
- Applied to sign-in, sign-up, forgot password, reset password, Settings → Profile, Settings →
  Preferences and the account-deletion dialog (not React Hook Form: same mapping through
  `serverFieldErrors`, new message `settings.privacy.delete.passwordRejected`). On the reset page a
  token the API cannot even parse (`VALIDATION_FAILED` on `body.token`) is shown as the dead-link
  state, like `INVALID_TOKEN`.

**Session re-check on any 401 (`lib/api/client.ts`, `lib/api/api.ts`, `lib/auth/session.ts`).**

- The API client gets an `onUnauthenticated(error, path)` hook, called when a request **finally**
  fails with 401 `UNAUTHENTICATED` (after the one CSRF retry); the request still rejects with its
  `ApiError`. `INVALID_CREDENTIALS` (also a 401) is not "signed out" and does not trigger it. A
  throwing hook cannot replace the request's error.
- The app client forwards it to one registered listener (`setUnauthenticatedListener`) — **except
  for `GET /auth/session` itself** (`SESSION_PATH`), whose 401 is the answer "signed out";
  reporting it would loop. The public client (`publicApi`) has no hook.
- `QueryProvider` connects the listener to `recheckSession(queryClient)` during render (children's
  queries start before a parent's effects; idempotent per client).
- `recheckSession` fetches the session once (`fetchQuery`, `staleTime: 0`); **concurrent 401s share
  one lookup**. Signed out → every cached query except the session is dropped (`dropUserData`, now
  shared with sign-in/sign-out/deletion), the CSRF token is forgotten, and the state becomes
  `signed-out` with **`reason: 'expired'`** when this tab believed it was signed in. Still signed
  in → nothing changes (the 401 was about something else; the request's own error shows). The
  check itself failing (offline) → nothing changes.
- `AuthGate` already redirects a signed-out state to `/auth/sign-in?next=<this page>` (safe `next`
  only, ADR-0020); `'expired'` keeps `next`, unlike an explicit sign-out. The sign-in form shows
  "Your session has ended. Sign in again to continue where you left off." as a `role="status"`
  note, and signing in returns to the page. No loops: the lookup never reports itself, the
  sign-in page never redirects a signed-out visitor, and `next` is never an auth page.

**Small related fixes.** After a confirmed sign-out of one device or of all other devices on
Settings → Security, focus goes to the sessions heading (the button that opened the dialog left
with its row, so Radix had nowhere to return focus and it fell to the page body); after a wrong
password in the deletion dialog, the emptied password field gets focus. ESLint and the
logical-CSS / design-guard tests skip `playwright-report/` and `test-results/`.

No new dependency.

## Alternatives considered

- **Show the API's `message` next to the field.** English only, developer-facing, may change: no.
- **Map server issues inside `schemaResolver`.** The resolver only sees values, not responses; a
  separate helper keeps the resolver pure and lets the non-RHF deletion dialog reuse the mapping.
- **A summary alert listing every invalid field** (GOV.UK pattern). With at most a few fields per
  form and focus moved to the first invalid one, the per-field text is enough; the existing
  `validation.summary` message stays available if a long form needs it.
- **Redirect to sign-in straight from the API client on 401.** The client has no router and no
  query cache; and a 401 is not always "signed out" (stale cookie on one route, or a different
  account signed in meanwhile in another tab). Re-checking first avoids wrong redirects.
- **TanStack `QueryCache`/`MutationCache` `onError`.** Misses requests made outside queries and
  mutations (the sign-out button, the CSRF token lookup) and fires per retry; the client hook sees
  every request once.
- **A global "session expired" dialog that keeps the page.** Would need the page to survive a
  different user signing in; dropping user data and re-entering through sign-in is simpler and
  safe. Unsaved form input on the page is lost (documented).

## Consequences

- Any new form uses `applyServerFieldErrors(error, form, FIELDS_IN_VISUAL_ORDER)` in its submit
  `catch` before its form-level message; any new API client request benefits from the 401
  re-check automatically.
- A field whose API name differs from the form field passes `rename`.
- What the user typed on a page whose session expired is lost after signing in again (the form is
  rebuilt from the API). Acceptable for settings forms; long-form editors (journal, Phase 5) may
  need a draft-preserving variant.
- Tests: unit (`server-errors.test.ts`, `client.test.ts`, `api.test.ts`, `session.test.ts`),
  component tests per form, an HTTP route test, and Playwright
  (`e2e/browser/forms-session.spec.ts`: a display name and a sign-up password the real API refuses
  after an in-flight change, shown on the field in en/desktop and fa/phone; cookies cleared under
  an open settings page → one session re-check → sign-in with the note → back to the page).
