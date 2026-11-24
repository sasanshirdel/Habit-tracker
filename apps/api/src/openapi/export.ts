import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { buildOpenApiDocument } from './openapi.document.js';
import { assertValidOpenApiDocument } from './openapi.validate.js';

/**
 * Writes the OpenAPI document to a file (backlog P1-06): `pnpm --filter @habit/api openapi:export
 * [out]`, default `dist/openapi.json`. CI uploads it as a build artifact.
 *
 * The app is created in Nest's preview mode: modules and routes are scanned but no provider is
 * instantiated, so nothing connects to PostgreSQL or Redis and no secret is needed. The
 * environment schema still runs at import, so missing connection URLs get unreachable
 * placeholders (the same ones the unit tests use) — they are validated, never dialled.
 */
process.env.DATABASE_URL ??= 'postgresql://openapi:openapi@127.0.0.1:1/openapi';
process.env.REDIS_URL ??= 'redis://127.0.0.1:1';

const out = resolve(process.argv[2] ?? 'dist/openapi.json');
const [{ AppModule }, { API_PREFIX }] = await Promise.all([
  import('../app.module.js'),
  import('../app.factory.js'),
]);
const app = await NestFactory.create(AppModule, { preview: true, logger: ['error'] });
try {
  const document = buildOpenApiDocument(app.get(ModulesContainer), { basePath: API_PREFIX });
  assertValidOpenApiDocument(document);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
  const operations = Object.values(document.paths).reduce(
    (n, item) => n + Object.keys(item).length,
    0,
  );
  process.stdout.write(`OpenAPI ${document.openapi}: ${operations} operation(s) → ${out}\n`);
} finally {
  await app.close();
}
