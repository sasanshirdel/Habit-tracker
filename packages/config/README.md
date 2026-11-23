# @habit/config

Shared configuration consumed by every workspace package:

- `tsconfig.base.json` — strict TypeScript defaults.
- `tsconfig.node.json` — Node/ESM (NodeNext) services such as `apps/api`.
- `tsconfig.nextjs.json` — Next.js App Router apps such as `apps/web`.
- `eslint` (`eslint.base.js`) — flat ESLint config (`@eslint/js` + `typescript-eslint`).
