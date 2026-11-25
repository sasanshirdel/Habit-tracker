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
| TanStack Query, React Hook Form, Recharts | 5.108.4 / 7.92.0 / 3.11.1 (**deferred**) | —          | Recorded for reference only; added when first needed.                                                                                   |

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
