# ADR-0001: Technology stack and pinned versions

- **Status:** Accepted (Phase 0)
- **Date:** 2026-11-24
- **Versions checked:** 2026-11-23/24 (UTC+03:30) against the public npm registry (`npm view <pkg> version`, `dist-tags`, `time`, `peerDependencies`, `engines`), Docker Hub tag API, GitHub Releases API, and `nodejs.org/dist/index.json`.

## Context

PRD §5.2 recommends a stack but explicitly says: _"Do not select a library solely because it appears in this proposal. Verify compatibility and current maintenance before adoption."_ Each candidate was checked for (a) an active release in the last ~3 months, (b) a stable (non-prerelease) `latest`, and (c) peer/engine compatibility with the rest of the stack.

## Decision

### Runtime and tooling

| Component  | Version pinned                                                 | Published                   | Notes                                                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js    | **24.22.3** (`.nvmrc`), engines `>=24.11 <25`                  | 2026-11-10                  | LTS "Krypton". Node 26 is the newer LTS (26.13.1) but was not chosen: more conservative ecosystem support; revisit in Phase 12. Node 22 (sandbox default) still works but leaves maintenance in 2027.                     |
| pnpm       | **12.21.0** (`packageManager`)                                 | 2026-11-13                  | 12.23.0 exists; 12.21.0 was the version available and verified locally. Uses `allowBuilds` allow-list and default minimum-release-age supply-chain checks.                                                                |
| TypeScript | **6.0.3**                                                      | 2026-04-16                  | **Not 7.0.2** (current `latest`, native Go compiler): `typescript-eslint` 8.73 peers `typescript >=4.8.4 <6.1.0` and `@nestjs/cli` 12 depends on `typescript ~6.0.2`. Revisit when the lint/Nest toolchain supports TS 7. |
| ESLint     | **10.15.0** + `@eslint/js` 10.0.1 + `typescript-eslint` 8.73.0 | 2026-11-13 / — / 2026-11-16 | ESLint 9.x is marked deprecated/unsupported on npm. `typescript-eslint` 8.74.0 was <24h old and blocked by pnpm's release-age policy, so 8.73.0 was pinned instead of adding exclusions.                                  |
| Prettier   | 3.10.1                                                         | 2026-11-12                  |                                                                                                                                                                                                                           |

### Frontend (`apps/web`)

| Component                                 | Version                                  | Published  | Notes                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js (App Router, Turbopack build)     | **16.4.6**                               | 2026-11-09 | `engines.node >=20.9`.                                                                                                                  |
| React / React DOM                         | **19.3.1**                               | 2026-10-14 |                                                                                                                                         |
| Tailwind CSS + `@tailwindcss/postcss`     | **4.3.5**                                | 2026-11-06 | CSS-first config (`@theme`), wired to design tokens.                                                                                    |
| `@next/eslint-plugin-next`                | 16.4.6                                   | 2026-11-09 | Used instead of `eslint-config-next`, whose bundled `eslint-plugin-react` 7.37.5 / `jsx-a11y` 6.10.2 / `import` 2.32.0 peer ESLint ≤ 9. |
| `eslint-plugin-react-hooks`               | 7.1.1                                    | 2026-04-17 | Declares ESLint 10 support.                                                                                                             |
| shadcn/ui CLI (`shadcn`)                  | 4.23.0 (**deferred to Phase 1**)         | 2026-10-27 | Copies component source into the repo; nothing to install in Phase 0.                                                                   |
| next-intl                                 | 4.16.0 (**deferred to Phase 1**)         | 2026-11-23 | Peers support Next 16 / React 19. Published <24h before the check; Phase 1 must re-verify. See ADR-0004.                                |
| TanStack Query, React Hook Form, Recharts | 5.108.4 / 7.92.0 / 3.11.1 (**deferred**) | —          | Recorded for reference only; added when first needed. TanStack Query added in P1-12, React Hook Form in P2-09 (addenda below).          |

### Backend (`apps/api`)

| Component                                                        | Version       | Published  | Notes                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS (`@nestjs/core`, `common`, `platform-express`, `testing`) | **12.6.0**    | 2026-11-20 | NestJS 12 ships as **ESM** (`"type": "module"`); the API is ESM with `NodeNext` resolution.                                                                                                                                                                                                                                        |
| `@nestjs/config`                                                 | 12.1.1        | 2026-11-06 |                                                                                                                                                                                                                                                                                                                                    |
| `@nestjs/cli`                                                    | 12.0.15       | 2026-11-20 | Dev-only (`nest start --watch`). Production build is plain `tsc`.                                                                                                                                                                                                                                                                  |
| Prisma CLI                                                       | **7.10.1**    | 2026-10-15 | **Not 8.0.0-rc.35**: npm `latest` tag currently points at a release candidate. 7.10.1 is the newest stable (also `@prisma/client` `latest`). Prisma 7 uses `prisma.config.ts` for the datasource URL and the `prisma-client` generator. `@prisma/client` + `@prisma/adapter-pg` 7.10.1 are added in Phase 1 with the first models. |
| zod                                                              | 4.6.7         | 2026-10-12 | Env validation now; shared validation later.                                                                                                                                                                                                                                                                                       |
| reflect-metadata / rxjs                                          | 0.2.2 / 7.8.2 | —          | Nest peers.                                                                                                                                                                                                                                                                                                                        |

### Testing

| Component                | Version                             | Notes                                                        |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------ |
| Vitest                   | 5.1.1 (2026-11-18)                  | One runner for all packages (ADR-0007). `engines.node ^22.12 |     | ^24 |     | >=26`. |
| unplugin-swc + @swc/core | 2.0.0 / 1.16.22                     | Emits decorator metadata for Nest DI in tests.               |
| supertest                | 7.3.2                               | HTTP tests against the Nest app.                             |
| Playwright               | 1.65.1 (**deferred to Phase 1/12**) | E2E.                                                         |

### Infrastructure

| Component        | Version                                                                                           | Notes                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL (dev) | `postgres:18.7-alpine`                                                                            | PG 19.0 images appeared the day of the check; 18 chosen until Prisma 7 support for 19 is confirmed.                                                                  |
| Redis (dev)      | `redis:8.8.4-alpine`                                                                              | BullMQ requires Redis ≥ 6.2. Redis 8 is AGPLv3/RSALv2/SSPL tri-licensed; Valkey is the fallback if licensing matters for production hosting (decision for Phase 12). |
| BullMQ / ioredis | 6.7.8 / 6.1.0 (**deferred to Phase 1** worker)                                                    |                                                                                                                                                                      |
| GitHub Actions   | `actions/checkout@v7` (v7.0.1), `actions/setup-node@v7` (v7.1.0), `pnpm/action-setup@v6` (v6.1.1) | Latest releases per GitHub API.                                                                                                                                      |
| Docker           | Compose file only                                                                                 | Docker is not available in the Phase 0 sandbox; compose file is unverified there.                                                                                    |

## Consequences

- Exact versions are pinned in every `package.json` (no `^`), and the lockfile is committed; upgrades are deliberate PRs.
- Three "latest" tags were **not** taken (TypeScript 7, Prisma 8 RC, ESLint 9-based Next config) for compatibility reasons. Each is a tracked upgrade item in the backlog.
- Anything marked _deferred_ must be re-verified (version, maintenance, peers) when it is actually installed.

## Addendum — Phase 1, P1-01 database foundation (2026-11-24)

Re-verified against the npm registry on 2026-11-24 (UTC+03:30) before installing, as required for
deferred items:

| Package              | Installed  | Published  | Notes                                                                                                                                                               |
| -------------------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@prisma/client`     | **7.10.1** | 2026-10-15 | npm `latest`. Matches the `prisma` CLI 7.10.1 pinned in Phase 0. `peerDependencies`: `prisma *`, `typescript >=5.4.0`; `engines.node ^20.19 \|\| ^22.12 \|\| >=24`. |
| `@prisma/adapter-pg` | **7.10.1** | 2026-10-15 | npm `latest`. Prisma 7 driver adapter for PostgreSQL; brings `pg` as its own dependency (`^8.16.3`, resolved **8.23.1**, published 2026-09-30).                     |

- `prisma` remains on **7.10.1**: npm `latest` still points at `8.0.0-rc.35` (release candidate), so the reasoning above stands (tracked in P1-16).
- `pg` is **not** a direct dependency of the API: only the adapter uses it, so it is not added to `package.json`.
- PostgreSQL server used for local verification: 18.7 (same major/minor as `postgres:18.7-alpine`), from the PGDG apt repository because the build sandbox has no Docker.
- The generated client (`prisma-client` generator, ESM, `.js` import extensions) is written to `apps/api/src/generated/prisma` (git-ignored) and regenerated by the API's `build`, `typecheck`, `test` and `dev` scripts.

## Addendum — Phase 1, P1-03 queues and worker (2026-11-24)

Re-verified against the npm registry on 2026-11-24 (UTC+03:30) before installing (`npm view <pkg> version dist-tags time engines peerDependencies peerDependenciesMeta dependencies`), and prototyped against Redis 8 (enqueue, retries/backoff, failed set, drain, behaviour with Redis down):

| Package   | Installed | Published  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | --------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bullmq`  | **6.7.8** | 2026-11-19 | npm `latest` (6.x actively released: 6.7.5–6.7.8 within the last two weeks; 5.x still patched). MIT. `engines.node >=14.18`. BullMQ 6 supports several backends; `ioredis`, `redis`, `pg` and `bullmq-otel` are **optional** peers (`peerDependenciesMeta`), so only `ioredis` is installed. Runtime deps: `msgpackr`, `cron-parser`, `semver`, `tslib`, `node-abort-controller`. Redis ≥ 6.2 required; we run 8.8.4 with `noeviction` (asserted by the integration tests). |
| `ioredis` | **6.0.0** | 2026-07-31 | Redis client used by BullMQ's Redis backend and directly for the shared producer connection and readiness `PING`. MIT, `engines.node >=20`. **Not 6.1.0** (npm `latest`): it was published 2026-11-23 12:41 (UTC+03:30), under 24 h before the check, so pnpm's minimum-release-age policy refuses it (same rule as `typescript-eslint` above); 6.0.0 satisfies BullMQ's `ioredis >=5.0.0` peer. Upgrade to 6.1.x in a later PR.                                            |

- **Not added: `@nestjs/bullmq` 12.0.2** (supports Nest 12 / BullMQ 6). It would add two packages (`@nestjs/bullmq`, `@nestjs/bull-shared`, the latter with a caret range) for decorators we do not need; our ~200-line `QueueModule`/`WorkerHost` gives explicit control over the things that matter here — fail-fast enqueueing, payload re-validation, log redaction and a bounded shutdown (BullMQ's own `close()`/`disconnect()` can wait indefinitely while Redis is unreachable; found while prototyping and covered by tests). Revisit if decorator-based processors become valuable.
- `msgpackr-extract` (optional native add-on of `msgpackr`) is **denied** in `allowBuilds`; `msgpackr` falls back to its pure-JS implementation, so no new native install script runs.
- `pg` appears in the lockfile as BullMQ's optional peer resolution; it was already present via `@prisma/adapter-pg` (8.23.1) and is not used by BullMQ here.

## Addendum — Phase 1, P1-07 structured logging (2026-11-24)

**No dependency added.** Evaluated with `npm view` on 2026-11-24 (UTC+03:30): `pino` **10.4.0**
(last modified 2026-10-02, 11 runtime dependencies) with `nestjs-pino` **5.3.2** (2026-11-19, peers
`pino ^10`, `pino-http ^11`, `@nestjs/common`/`@nestjs/core` `^11.0.8 || ^12.0.2` — compatible with
our Nest 12.6.0). Both are maintained, but pino's path-based redaction does not cover key matching at
any depth or credentials inside strings, so a custom redactor is needed regardless; the remaining
value (JSON serialisation, stdout writer) did not justify three direct packages. The API and worker
use an in-repo `JsonLogger` instead — rationale and the redaction rules in
[ADR-0010](0010-structured-logging-and-redaction.md).

## Addendum — Phase 1, P1-08 security headers and rate limiting (2026-11-24)

**No dependency added.** Evaluated with `npm view` on 2026-11-24 (UTC+03:30): `helmet` **8.3.0**
(last modified 2026-07-12), `@nestjs/throttler` **6.8.0** (2026-11-16, peers Nest `^7 … ^12`) with
`@nest-lab/throttler-storage-redis` **1.2.0** (2026-02-03, peers Nest `^7 … ^11` — does not declare
our Nest 12.6.0), and `rate-limiter-flexible` **11.5.0** (2026-11-15). The API's headers are a fixed
list set by an in-repo middleware, and rate limiting is one atomic Lua script on the ioredis
connection we already own (P1-03); the web CSP uses Next.js 16's built-in `proxy.ts` nonce support.
Rationale and policy details in [ADR-0011](0011-security-headers-cors-and-rate-limiting.md).

## Addendum — Phase 1, P1-06 OpenAPI (2026-11-25)

**No dependency added.** Evaluated with `npm view` on 2026-11-25 (UTC+03:30): `@nestjs/swagger`
**12.1.2** (last modified 2026-11-13, peers Nest `^12` plus `class-validator`/`class-transformer`;
bundles `swagger-ui-dist` 5.34.1), `nestjs-zod` **5.6.0** (2026-11-08, peers Nest `^10 || ^11` — does
not declare our Nest 12.6.0), `zod-openapi` **6.0.2** (2026-08-31) and
`@asteasolutions/zod-to-openapi` **9.1.0** (2026-07-19), both peers `zod ^4`. The document is
generated in-repo from Nest's route metadata and the routes' zod schemas with zod 4.6.7's built-in
`z.toJSONSchema` (JSON Schema 2020-12, the OpenAPI 3.1 dialect); no HTML UI is served. Rationale in
[ADR-0012](0012-openapi-from-zod.md). CI uses `actions/upload-artifact@v7` (latest release v7.0.2,
2026-10-07) for the exported document.

## Addendum — Phase 1, P1-10 next-intl (2026-11-25)

Re-verified against the npm registry on 2026-11-25 (UTC+03:30) before installing
(`npm view next-intl version time dependencies peerDependencies license`), as ADR-0004 requires:

| Package     | Installed  | Published  | Notes                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next-intl` | **4.16.0** | 2026-11-23 | MIT, single maintainer (amannn), actively released. Peers `next ^12 … ^16`, `react ^16.8 … ^19` — matches Next 16.4.6 / React 19.3.1. **Not 4.16.1** (npm `latest`): published 2026-11-24 13:01 (UTC+03:30), under 24 h before the install, so pnpm's minimum-release-age policy refuses it (same rule as `typescript-eslint` and `ioredis` above). |

Transitive runtime packages, all from the next-intl repository unless noted: `use-intl` 4.15.1,
`icu-minify` 4.15.3, `@formatjs/intl-localematcher` (formatjs), `negotiator` 1.1.0 (jshttp), and
the message-extractor stack (`@eloqnt/*` 0.1.x, `next-intl-swc-plugin-extractor` 4.15.1,
`@swc/core` 1.16 — already allowed). The extractor is **not enabled**; its file watcher
`@parcel/watcher` 2.6.0 has an install script that compiles native code, so it is **denied** in
`allowBuilds` (like `msgpackr-extract`) and never loaded. Usage and decisions: ADR-0004 "Phase 1
implementation".

Considered and not chosen: keeping the Phase 0 stub plus `intl-messageformat` and a hand-written
negotiator — next-intl already brings ICU formatting, typed keys, server/client message loading and
an open-redirect-hardened locale middleware, which is what ADR-0004 decided on.

## Addendum — Phase 1, P1-09 design system (2026-11-25)

Checked with `npm view <pkg> version time peerDependencies engines license` on 2026-11-25
(UTC+03:30); all pinned exactly. Rationale in [ADR-0013](0013-design-system.md).

| Package                          | Installed   | Published  | Where / notes                                                                                                                                            |
| -------------------------------- | ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `radix-ui`                       | **1.8.1**   | 2026-10-13 | ui. Headless primitives (Dialog, DropdownMenu, Toast, Slot, Direction). MIT. Peers React `^16.8 … ^19`.                                                  |
| `class-variance-authority`       | **0.7.1**   | 2024-11-26 | ui. Variant classes (shadcn). Apache-2.0; stable, no newer release.                                                                                      |
| `clsx`                           | **2.1.1**   | 2024-04-23 | ui. Class joining for `cn()`. MIT.                                                                                                                       |
| `tailwind-merge`                 | **3.7.1**   | 2026-11-20 | ui. Tailwind v4 conflict resolution for `cn()`. MIT.                                                                                                     |
| `lucide-react`                   | **1.78.0**  | 2026-11-23 | ui and web. Icons (shadcn default). ISC. **Not 1.79.0** (npm `latest`, published 2026-11-24 09:42 — under pnpm's minimum release age).                   |
| `tw-animate-css`                 | **1.4.0**   | 2025-09-24 | ui (CSS only). Enter/exit animations for Tailwind v4 used by the primitives. MIT.                                                                        |
| `get-nonce`                      | **1.0.1**   | 2022-05-03 | ui. Already in the tree via `react-style-singleton`; direct so `UiProvider` can hand it the CSP nonce (same resolved version, one module instance). MIT. |
| `@fontsource-variable/inter`     | **5.3.0**   | 2026-07-19 | web. Self-hosted Inter (variable, `unicode-range` subsets). OFL-1.1.                                                                                     |
| `@fontsource-variable/vazirmatn` | **5.3.0**   | 2026-07-19 | web. Self-hosted Vazirmatn (Arabic + Latin subsets). OFL-1.1.                                                                                            |
| `@testing-library/react`         | **16.3.3**  | 2026-08-27 | ui (dev). Component tests. Peers React 19, `@testing-library/dom ^10`.                                                                                   |
| `@testing-library/dom`           | **10.4.2**  | 2026-09-13 | ui (dev). Peer of the above.                                                                                                                             |
| `@testing-library/user-event`    | **14.6.13** | 2026-11-19 | ui (dev). Realistic pointer/keyboard interaction in tests.                                                                                               |
| `jsdom`                          | **31.0.1**  | 2026-11-13 | ui (dev). DOM for component tests. `engines.node ^24.15` — matches Node 24.22.3. Its `@napi-rs/canvas` peer is optional and not installed.               |

React 19.3.1 / react-dom 19.3.1 / `@types/react(-dom)` 19.3.0 were added to `packages/ui` as dev
dependencies (same versions as `apps/web`) with `react`/`react-dom ^19` as peers. No new install
scripts: `pnpm install` raised no `ERR_PNPM_IGNORED_BUILDS`.

Not added: `sonner` 2.0.8 (injects an un-nonced `<style>`), `next-themes` (inline script), the
`shadcn` CLI as a dependency (used only to read the registry sources).

## Addendum — Phase 1, P1-11 application shell (2026-11-25)

No new packages. `apps/web` gained the component-test dev dependencies `packages/ui` already uses,
at the **same pinned versions** (one resolved copy each in the lockfile): `@testing-library/react`
16.3.3, `@testing-library/dom` 10.4.2, `@testing-library/user-event` 14.6.13, `jsdom` 31.0.1. They
run the shell's component tests (`// @vitest-environment jsdom`); the app's other tests stay in the
`node` environment.

## Addendum — Phase 1, P1-12 frontend data layer (2026-11-25)

| Package                 | Installed   | Published  | Where / notes                                                                                                 |
| ----------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `@tanstack/react-query` | **5.108.4** | 2026-11-23 | web. Client cache for API data (ADR-0014). MIT; peers React `^18 \|\| ^19`; npm `latest`; no install scripts. |
| `@tanstack/query-core`  | 5.108.4     | 2026-11-23 | Its only dependency (transitive).                                                                             |

`apps/web` now also depends on the workspace package `@habit/shared-types` (response types, error
codes). No other new packages; the HTTP client is in-repo `fetch` (ADR-0014).

## Addendum — Phase 1, P1-13 browser end-to-end tests (2026-11-25)

Checked with `npm view <pkg> version dist-tags time dependencies engines license` on 2026-11-25
(UTC+03:30); pinned exactly. Rationale and usage in [ADR-0015](0015-browser-end-to-end-tests.md).

| Package            | Installed  | Published  | Where / notes                                                                                                                                                                                  |
| ------------------ | ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@playwright/test` | **1.65.1** | 2026-11-14 | web (dev). Browser test runner. Apache-2.0, Microsoft; npm `latest` (1.66 is only in `alpha`/`next`); `engines.node >=20`; well past pnpm's minimum release age. Its only dependency is below. |
| `playwright`       | 1.65.1     | 2026-11-14 | Transitive. Depends only on `playwright-core`.                                                                                                                                                 |
| `playwright-core`  | 1.65.1     | 2026-11-14 | Transitive. No dependencies.                                                                                                                                                                   |

No install scripts: browsers are **not** downloaded on `pnpm install`; they are installed explicitly
(`pnpm --filter @habit/web exec playwright install --only-shell chromium`; CI caches them). This
version drives Chrome Headless Shell 159.0.8154.6 (revision 1255). `next` lists `@playwright/test`
as an optional peer, so the lockfile now records it on `next`'s peer set — no change to Next itself.

## Addendum — Phase 2, P2-02 password hashing (2026-11-26)

**No new package.** Argon2id comes from Node's built-in `crypto.argon2()` (added in Node 24.7.0;
the repository requires `>=24.11 <25`; Node 24.22.3 bundles OpenSSL 3.5.9), verified against the
RFC 9106 and reference-implementation test vectors. Checked with `npm view <pkg> version license
time scripts dependencies optionalDependencies engines` on 2026-11-26 (UTC+03:30) and not added:
`argon2` 0.45.2 (MIT, npm provenance; native addon with a `node-gyp-build` **install script**, which
`allowBuilds` in `pnpm-workspace.yaml` would block until explicitly allowed, plus toolchain/musl
concerns for CI and Docker), `@node-rs/argon2` 2.2.2 (13 platform-specific prebuilt binaries), and
`hash-wasm` 4.13.0 (WASM). `pnpm-workspace.yaml`, `package.json` files and the lockfile are
unchanged. Parameters and rationale: [ADR-0018](0018-email-password-authentication.md).

## Addendum — Phase 2, P2-09 auth pages (2026-11-26)

| Package           | Installed  | Published  | Where / notes                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react-hook-form` | **7.92.0** | 2026-11-11 | `apps/web` only. Form state, validation timing and focus management for the auth forms and the larger forms to come (backlog choice, deferred list above). MIT, one maintainer (bluebill1049), actively released; **no dependencies**, peer `react ^16.8 … ^19` (React 19.3.1 here), no install script. `latest` at the check; older than pnpm's minimum release age. |

Checked with `npm view react-hook-form version time dependencies peerDependencies license
maintainers` on 2026-11-26 (UTC+03:30); pinned exactly, lockfile updated by `pnpm add --save-exact`.
**Not added:** `@hookform/resolvers` 7.0.9 (2026-11-24) — supports zod 4, but declares ~20 optional
peer dependencies and depends on `@standard-schema/utils`; a 25-line in-repo resolver over the
shared schemas does the one thing needed (`apps/web/lib/forms/schema-resolver.ts`). `apps/web`
does not depend on `zod` directly (the schemas come from `@habit/shared-validation`, already an
allowed edge). Usage: [ADR-0020](0020-web-authentication-pages-and-route-protection.md).
