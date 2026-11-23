# @habit/api

NestJS 12 (ESM) REST API — the modular monolith backend. Phase 0 contains only:

- `GET /api/v1/health` liveness endpoint
- zod-validated environment configuration (`src/config/env.ts`) — the app fails fast on invalid config
- Prisma 7 schema skeleton (`prisma/schema.prisma`, `prisma.config.ts`) with **no product tables**

```bash
pnpm --filter @habit/api dev        # watch mode (nest CLI)
pnpm --filter @habit/api build      # tsc -> dist/
pnpm --filter @habit/api start      # node dist/main.js
pnpm --filter @habit/api test       # vitest (unit + supertest e2e)
DATABASE_URL=postgresql://... pnpm --filter @habit/api prisma:validate
```
