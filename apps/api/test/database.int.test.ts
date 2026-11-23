import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { prismaCli } from './integration/prisma-cli.js';

// Integration: real PostgreSQL, migrations applied by `prisma migrate deploy` in global setup.
const databaseUrl = inject('integrationDatabaseUrl');
const databaseName = inject('integrationDatabaseName');
const prisma = (args: string[]) => prismaCli(args, databaseUrl);

describe('database foundation (real PostgreSQL)', () => {
  let app: INestApplication;
  // Imported lazily: ConfigModule validates env when AppModule is first evaluated.
  let PrismaServiceToken: typeof import('../src/database/index.js').PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const { createApp } = await import('../src/app.factory.js');
    ({ PrismaService: PrismaServiceToken } = await import('../src/database/index.js'));
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('applied every migration (prisma migrate deploy)', async () => {
    const prismaService = app.get(PrismaServiceToken);
    const rows = await prismaService.$queryRaw<
      { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
    >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
    expect(rows.map((r) => r.migration_name)).toContain('20261123211113_baseline');
    for (const row of rows) {
      expect(row.finished_at).not.toBeNull();
      expect(row.rolled_back_at).toBeNull();
    }
  });

  it('reports no pending migrations and deploy is idempotent', () => {
    const status = prisma(['migrate', 'status']);
    expect(status.code, status.output).toBe(0);
    expect(status.output).toMatch(/up to date/i);

    const again = prisma(['migrate', 'deploy']);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toMatch(/no pending migrations/i);
  });

  it('has no drift between the migrated database and schema.prisma', () => {
    const diff = prisma([
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--exit-code',
    ]);
    expect(diff.code, diff.output).toBe(0);
  });

  it('PrismaService talks to the configured database', async () => {
    const prismaService = app.get(PrismaServiceToken);
    const [row] = await prismaService.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    expect(row?.db).toBe(databaseName);
  });

  it('GET /api/v1/health/ready returns 200 when the database is up', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'up' } });
    expect(JSON.stringify(res.body)).not.toContain(databaseName);
  });
});
