import { PrismaPg } from '@prisma/adapter-pg';
import type { TestProject } from 'vitest/node';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { throwawayDatabaseName, withDatabase } from './database-url.js';
import { prismaCli } from './prisma-cli.js';
import { deleteKeysWithPrefix, throwawayKeyPrefix } from './redis-keys.js';
import { RespClient } from './redis-resp.js';

declare module 'vitest' {
  export interface ProvidedContext {
    integrationDatabaseUrl: string;
    integrationDatabaseName: string;
    integrationRedisUrl: string;
    /** Every key an integration test writes must start with this prefix (cleaned up afterwards). */
    integrationRedisKeyPrefix: string;
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
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error(
      'Integration tests need REDIS_URL (e.g. redis://localhost:6379). ' +
        'Start one with `pnpm dev:services` or see docs/DEVELOPMENT_WORKFLOW.md.',
    );
  }

  // Fail fast if Redis is unreachable, before creating anything in PostgreSQL.
  const redis = await RespClient.connect(redisUrl);
  const redisKeyPrefix = throwawayKeyPrefix();

  const name = throwawayDatabaseName();
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: baseUrl }) });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await admin.$disconnect();
    await redis.quit();
    throw err;
  }

  const databaseUrl = withDatabase(baseUrl, name);
  const deploy = prismaCli(['migrate', 'deploy'], databaseUrl);
  if (deploy.code !== 0) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
    await redis.quit();
    throw new Error(`prisma migrate deploy failed:\n${deploy.output}`);
  }

  project.provide('integrationDatabaseUrl', databaseUrl);
  project.provide('integrationDatabaseName', name);
  project.provide('integrationRedisUrl', redisUrl);
  project.provide('integrationRedisKeyPrefix', redisKeyPrefix);

  return async () => {
    try {
      // Only this run's keys are removed — never FLUSHDB, the Redis may be a shared dev instance.
      await deleteKeysWithPrefix(redis, redisKeyPrefix);
    } finally {
      await redis.quit();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$disconnect();
    }
  };
}
