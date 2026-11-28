import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDENTITY_LIMITS, PASSWORD_HASH_PREFIX, SECRET_TOKEN_HASH_BYTES } from './index.js';

// The identity CHECK constraints live in hand-written migration SQL (Prisma cannot express them),
// so this keeps the application constants and the database in step without a database.
const migrationsDir = resolve(import.meta.dirname, '../../../prisma/migrations');
const identityMigration = readdirSync(migrationsDir).find((d) => d.endsWith('_identity'));
const sql = readFileSync(
  resolve(migrationsDir, identityMigration ?? 'missing', 'migration.sql'),
  'utf8',
);
const schema = readFileSync(resolve(migrationsDir, '../schema.prisma'), 'utf8');

describe('identity schema (P2-01)', () => {
  it('has the identity migration', () => {
    expect(identityMigration).toBeDefined();
  });

  it('database CHECK bounds match the application limits', () => {
    expect(sql).toContain(`char_length("email") BETWEEN 3 AND ${IDENTITY_LIMITS.emailMaxLength}`);
    expect(sql).toContain(
      `char_length("display_name") BETWEEN 1 AND ${IDENTITY_LIMITS.displayNameMaxLength}`,
    );
    expect(sql).toContain(
      `char_length("timezone") BETWEEN 1 AND ${IDENTITY_LIMITS.timezoneMaxLength}`,
    );
    expect(sql).toContain(`"password_hash" LIKE '${PASSWORD_HASH_PREFIX}%'`);
    expect(
      sql.match(new RegExp(`octet_length\\("token_hash"\\) = ${SECRET_TOKEN_HASH_BYTES}`, 'g')),
    ).toHaveLength(2);
  });

  it('creates the citext extension before using it', () => {
    const ext = sql.indexOf('CREATE EXTENSION IF NOT EXISTS "citext"');
    expect(ext).toBeGreaterThanOrEqual(0);
    expect(ext).toBeLessThan(sql.indexOf('CITEXT'));
  });

  it('is additive only (no DROP, no data rewrite)', () => {
    const statements = sql.replace(/--.*$/gm, '');
    // Statement-leading destructive verbs, plus column/constraint drops inside ALTER TABLE.
    expect(statements).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
    expect(statements).not.toMatch(
      /\b(DROP\s+(COLUMN|CONSTRAINT|TABLE|TYPE|INDEX)|ALTER\s+COLUMN)\b/i,
    );
  });

  it('uses app-generated UUIDv7 ids and timestamptz for every model', () => {
    const idLines = schema.match(/^\s+(id|userId)\s+String\s+@id.*$/gm) ?? [];
    expect(idLines.length).toBeGreaterThanOrEqual(6);
    for (const line of idLines) expect(line).toContain('@db.Uuid');
    for (const line of schema.match(/^\s+id\s+String\s+@id.*$/gm) ?? []) {
      expect(line).toContain('@default(uuid(7))');
    }
    // Instants (`…At`) are timestamptz(3); local calendar days (habits, P3-01, ADR-0028) are `date`.
    for (const line of schema.match(/^\s+\w+\s+DateTime\??\s.*$/gm) ?? []) {
      if (/^\s+\w+At\s/.test(line)) expect(line).toContain('@db.Timestamptz(3)');
      else expect(line).toContain('@db.Date');
    }
  });
});

describe('identity enums (P2-01)', () => {
  it('the stored locale enum is exactly the product locales', async () => {
    const { locales } = await import('@habit/localization');
    const { Locale, ThemePreference } = await import('../../generated/prisma/enums.js');
    expect(Object.values(Locale).sort()).toEqual([...locales].sort());
    // ADR-0013 themes; dark is the product default and the column default.
    expect(Object.values(ThemePreference).sort()).toEqual(['dark', 'light', 'system']);
    expect(schema).toMatch(/theme\s+ThemePreference\s+@default\(dark\)/);
  });
});
