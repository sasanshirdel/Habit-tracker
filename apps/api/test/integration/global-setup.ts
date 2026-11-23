import { PrismaPg } from '@prisma/adapter-pg';
import type { TestProject } from 'vitest/node';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { throwawayDatabaseName, withDatabase } from './database-url.js';
import { prismaCli } from './prisma-cli.js';

declare module 'vitest' {
  export interface ProvidedContext {
    integrationDatabaseUrl: string;
    integrationDatabaseName: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      'Integration tests need DATABASE_URL (a PostgreSQL role allowed to CREATE DATABASE). ' +
        'Start one with `pnpm dev:services` or see docs/DEVELOPMENT_WORKFLOW.md.',
    );
  }

  const name = throwawayDatabaseName();
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: baseUrl }) });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);

  const databaseUrl = withDatabase(baseUrl, name);
  const deploy = prismaCli(['migrate', 'deploy'], databaseUrl);
  if (deploy.code !== 0) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
    throw new Error(`prisma migrate deploy failed:\n${deploy.output}`);
  }

  project.provide('integrationDatabaseUrl', databaseUrl);
  project.provide('integrationDatabaseName', name);

  return async () => {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
  };
}
