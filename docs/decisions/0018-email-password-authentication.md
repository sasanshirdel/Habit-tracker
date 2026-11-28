# ADR-0018: Email/password registration and sign-in (Argon2id, sessions, lockout)

- **Status:** Accepted (P2-02)
- **Date:** 2026-11-26

## Context

PRD §3.11 (email registration, secure password authentication, secure session management) and
§4, ADR-0005 (opaque server-side sessions in `__Host-session`, Argon2id, progressive lockout,
generic errors) and ADR-0017 (identity tables) need a working sign-up/sign-in. Backlog P2-02
(#22) scopes: Argon2id hashing (verify the library), password policy, the session cookie with
rotation on sign-in, sign-out and sign-out-everywhere, generic errors (no enumeration), and
brute-force lockout/backoff. CSRF and the deny-by-default guard are P2-03; verification email
P2-04; recovery P2-05; the session list and security events P2-08; pages P2-09.

## Decision

### Password hashing: Node's built-in `crypto.argon2` — no new dependency

- Node.js added `crypto.argon2()` in **v24.7.0** (OpenSSL 3.2+ implementation; Node 24.22.3 ships
  OpenSSL 3.5.9). The repository requires Node `>=24.11 <25` (`engines`, `.nvmrc`), so every
  supported runtime has it. The API documents it without an experimental/stability-1 marker
  (checked 2026-11-26 in the v24 docs).
- Verified against the **RFC 9106 §5.3 Argon2id test vector** and the **reference
  implementation's** Argon2id PHC test vector (`password`/`somesalt`, m=65536,t=2,p=1) — both unit
  tests.
- Candidates checked with `npm view` on 2026-11-26 and **not** added:

  | Package           | Version / published                  | Why not                                                                                                                                                                                                                                                                                  |
  | ----------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `argon2`          | 0.45.2 (2026-11-03), MIT, provenance | Native addon with an **install script** (`node-gyp-build`; prebuilds, else a C++ toolchain): would need an `allowBuilds` exception in `pnpm-workspace.yaml`, toolchain/musl handling in CI and Docker, plus 4 runtime deps (`cross-env`, `@phc/format`, …). 1.0.0-beta.1 is <2 days old. |
  | `@node-rs/argon2` | 2.2.2 (2026-10-06), MIT              | Prebuilt napi-rs binaries via 13 platform `optionalDependencies` (no install script), but still third-party native code per platform for what the runtime now provides.                                                                                                                  |
  | `hash-wasm`       | 4.13.0 (2026-11-07), MIT             | Pure WASM (portable) but slower than native and a dependency for something the runtime has.                                                                                                                                                                                              |

  Consequences: nothing added to `package.json`/lockfile, no `allowBuilds` change, no release-age
  question, no native build in CI or Docker images. If a future runtime lacked `crypto.argon2`,
  `PasswordHasher` is the single place to swap in `argon2` (same PHC format, so stored hashes stay
  valid).

- **Parameters** (`ARGON2ID_PARAMS`): Argon2id, **m = 19 456 KiB (19 MiB), t = 2, p = 1**, 16-byte
  random salt, 32-byte hash — the OWASP Password Storage Cheat Sheet minimum configuration
  (checked 2026-11-26; RFC 9106 recommends the 16-byte salt and 32-byte tag). 23–32 ms per hash on
  the arm64 development sandbox (7 samples, Node 24.22.3). Raise memory/passes when production hardware is known; stored hashes
  carry their parameters, and sign-in transparently re-hashes old ones (`needsRehash`).
- **Format:** standard PHC string `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>` (unpadded base64) —
  what the database CHECK of ADR-0017 accepts and what the reference implementation/libraries write.
  The parser is strict (exact base64 round-trip) and refuses stored parameters outside sane bounds
  (memory ≤ 1 GiB, passes ≤ 16, lanes ≤ 16, salt 8–64 B, hash 16–64 B), so a tampered row can never
  make the API compute an enormous hash; such a hash simply never matches.
- **Hash-flood protection:** at most **2** Argon2 computations run at once per process (each
  holds 19 MiB and a libuv thread-pool slot), at most **64** wait; beyond that the request gets
  503 `SERVICE_UNAVAILABLE` instead of queueing unbounded memory-hard work. The per-address `auth`
  rate limit keeps any single client far below that.
- **No pepper** (consistent with ADR-0017: no secret to manage yet). Revisit with the secret
  manager decision.

### Password policy (`@habit/shared-validation`, shared with the web forms of P2-09)

- **8–128 characters**, counted as Unicode code points after **NFKC** normalisation (NIST SP
  800-63B), so the same password typed on different keyboards hashes identically. The raw string is
  capped at 1 024 UTF-16 units before any normalisation. No composition rules, no trimming, no
  truncation; spaces, Persian letters and emoji are allowed. Errors use zod's `too_small`/`too_big`
  codes for localisation and never echo the value.
- Sign-in only bounds the password (1..1 024 raw), so a policy change never locks anyone out.
- No breached/common-password check yet (the issue lists it as optional; ASVS 5 asks for a
  top-passwords list at L1) — see open decisions.

### Email normalisation (consistent with ADR-0017's `citext`)

Trim surrounding whitespace, lower-case the whole address (exactly the equality `citext` applies,
so what we store is what the unique index compares), syntax-check with zod's `email()` (ASCII
addresses only for now), ≤ 254 characters. Provider-specific rewriting (Gmail dots, `+tags`) is not
applied.

### Routes (`/api/v1/auth`, identity module, tag `Auth`)

| Route                          | Rate limit                   | Success                          | Failure                                       |
| ------------------------------ | ---------------------------- | -------------------------------- | --------------------------------------------- |
| `POST /auth/register`          | `default` + `auth`           | 202 `{ status: 'accepted' }`     | 400 `VALIDATION_FAILED`                       |
| `POST /auth/login`             | `default` + `auth` + lockout | 200 `{ user }` + `Set-Cookie`    | 401 `INVALID_CREDENTIALS`, 429 `RATE_LIMITED` |
| `POST /auth/logout`            | `default`                    | 204, cookie cleared (idempotent) | —                                             |
| `POST /auth/logout-everywhere` | `default`                    | 204, cookie cleared              | 401 `UNAUTHENTICATED` (no active session)     |

- **Registration** creates `users` + `user_profiles` + `user_preferences` (locale and IANA time
  zone are required — ADR-0017 has no default locale) + `user_password_credentials` in one nested
  write. It answers **202 with the same body whether or not the address is taken** (including
  soft-deleted accounts), and always computes the Argon2id hash first, so neither body nor timing
  reveals registered addresses. A taken address is left untouched. It does **not** sign in (a session
  only for new accounts would itself reveal which addresses exist); the client signs in next. P2-04
  will email the real owner of a taken address.
- **Sign-in** spends exactly one Argon2id verification on every path: unknown address, deleted
  account and account without a password (Google-only, P2-06) are verified against a per-process
  **dummy hash** with the current parameters (made at startup). Every failure is the same 401
  `INVALID_CREDENTIALS` (new `ApiErrorCode`, localised `apiErrors.INVALID_CREDENTIALS` in en/fa).
  The integration suite asserts identical bodies/headers and comparable latency (median ratio
  0.5–2; without the dummy hash it measures ≈ 0.2).
- **Sessions:** 256-bit random token in the cookie, SHA-256 in `user_sessions` (ADR-0017).
  Cookie `__Host-session=<token>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` (no
  `Domain`). **Absolute lifetime 30 days, idle timeout 7 days** (`last_used_at`, written at most
  once a minute). A session cookie presented at sign-in is revoked as `rotated` (fixation).
  Sign-out revokes the presented session (`sign_out`); sign-out-everywhere revokes every open
  session of that user (`sign_out_everywhere`). No session id or token appears in a body or log.
- **Brute force:** besides the per-address `auth` class (10 per 5 min, fails closed — ADR-0011),
  a **progressive lockout per submitted email address**: from the 5th consecutive failure the
  address is locked for 1 min, then 2, 4, 8, max 15 min per further failure; failures are
  forgotten 1 h after the last one or at a successful sign-in. While locked, every attempt (even the
  right password) gets 429 `RATE_LIMITED` with `Retry-After` and `details.policy: "login-account"`,
  without any password work. Keyed by the address **whether or not an account exists**, so it is no
  enumeration oracle. Redis keys `<RATE_LIMIT_PREFIX>:login-account:{fail,lock}:<sha256(address)[:32]>`
  with TTLs; fails closed (503) without Redis.
- **Logging:** nothing logs passwords, tokens, hashes or email addresses (asserted in e2e and
  integration tests); a successful sign-in sets the request's `userId` so the access line carries
  the opaque id; a lockout logs one warning without the address.

### Boundary with P2-03 (CSRF and guards)

P2-02 adds no protected business route. Until P2-03: login/register accept only
`application/json` bodies (a cross-site HTML form cannot produce one, and a cross-origin `fetch`
with JSON needs a CORS preflight that foreign origins fail — ADR-0011), and `SameSite=Lax` keeps
the cookie off cross-site `POST`s, so cross-site sign-out/sign-out-everywhere cannot carry it.
**Residual risk:** same-site (sibling subdomain) requests are not yet CSRF-checked; P2-03 adds the
Origin/`Sec-Fetch-Site` or token check to every state-changing cookie-authenticated route,
including these, and the deny-by-default `AuthGuard`/`@CurrentUser()` built on
`SessionService.resolve`. Nothing on `main` should be deployed publicly before P2-03 lands.

**Update (P2-03, ADR-0019):** done — all four routes pass the global `AuthGuard` (origin check on
all; session token on logout with a live session and on logout-everywhere, which is now a protected
route using `@CurrentUser()`); sign-in returns the session's `csrfToken`; `GET /auth/session` added.

**Update (P2-04, ADR-0021):** registration now queues one email job for the account the address
belongs to (verification link, or a "you already have an account" notice for a verified address;
nothing for a soft-deleted one) — at most once per account per 15 minutes; the 202 is unchanged.
Sign-in and `GET /auth/session` report `emailVerified`; unverified accounts may sign in (interim).

## Alternatives considered

- **`argon2` / `@node-rs/argon2` / `hash-wasm`** — see the table above.
- **409 `CONFLICT` for a taken address** — simplest UX, but an enumeration oracle. Rejected.
- **Signing in right after registration** — only possible for new accounts, which reveals whether
  the address existed. Rejected until email verification (P2-04) can carry the flow.
- **Hard account lockout until reset** — lets anyone lock a known user out indefinitely. Progressive,
  capped lockout instead.
- **JWT access/refresh tokens** — ADR-0005 chose opaque, revocable server-side sessions.

## Open decisions (interim choices, reversible; for the owner)

1. **Minimum password length 8** (ASVS floor). ASVS 5 "strongly recommends" 15; NIST SP 800-63B-4
   requires 15 for single-factor passwords. Raising it is one constant.
2. **Common/breached-password check** — not implemented (optional in the issue). Options: a bundled
   top-N list (ASVS L1) or a k-anonymity breach API (an external call at sign-up).
3. **Session lifetimes** 30 days absolute / 7 days idle.
4. **Lockout policy** 5 failures → 1 min doubling to 15 min, 1 h memory.
5. **Argon2id cost** at the OWASP minimum; tune on production hardware.

## Consequences

- Sign-up/sign-in/sign-out work end-to-end against PostgreSQL and Redis; the web pages arrive in
  P2-09 and can reuse the shared schemas for client-side feedback.
- Registration UX: a user who mistypes into an existing address gets no immediate hint (by design);
  P2-04's email closes that gap.
- Every sign-in costs ~19 MiB × ≤ 2 concurrent and tens of ms of CPU; the concurrency cap and the
  `auth` limit bound it.
- P2-03 must add CSRF checks to the four routes here and build the guard on `SessionService`.
