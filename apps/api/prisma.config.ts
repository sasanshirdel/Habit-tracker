import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load `.env` files itself. For local development, load the repository-root
// `.env` (created from `.env.example`) when DATABASE_URL is not already in the environment.
// CI and deployed environments set DATABASE_URL directly; values in the environment always win.
if (!process.env.DATABASE_URL) {
  for (const file of ['.env', '../../.env']) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      break;
    }
  }
}

// Prisma 7 reads the connection URL from here, not from schema.prisma.
// `prisma generate` and `prisma validate` do not connect, so an empty URL is acceptable for them;
// migrate commands fail with a clear Prisma error if DATABASE_URL is missing.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
