# @habit/config

Shared configuration consumed by every workspace package:

- `tsconfig.base.json` — strict TypeScript defaults.
- `tsconfig.node.json` — Node/ESM (NodeNext) services such as `apps/api`.
- `tsconfig.nextjs.json` — Next.js App Router apps such as `apps/web`.
- `eslint` (`eslint.base.js`) — flat ESLint config (`@eslint/js` + `typescript-eslint`).
- `architecture/` — the repository's architecture check (P1-15, ADR-0016): `rules.js` (allowed
  workspace graph, app exception, API layout), `check.js` (the checker), `cli.js` (run by the root
  `pnpm check:architecture`, which `pnpm lint` calls) and `check.test.js` (rule fixtures plus a
  "this repository passes" test, run by `pnpm test`).
