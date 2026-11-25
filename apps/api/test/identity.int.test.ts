import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { issueSecretToken } from '../src/modules/identity/index.js';
import { throwawayDatabaseName, withDatabase } from './integration/database-url.js';
import { prismaCli } from './integration/prisma-cli.js';

// Integration (backlog P2-01): the identity tables on a real PostgreSQL, migrated by
// `prisma migrate deploy` in global setup. Every constraint is exercised through the database
// itself, because the application code that writes these tables only arrives with P2-02+.
const databaseUrl = inject('integrationDatabaseUrl');
const apiRoot = resolve(import.meta.dirname, '..');
const migrationsDir = resolve(apiRoot, 'prisma/migrations');

const ARGON2ID_EXAMPLE =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc';
const DAY = 24 * 60 * 60 * 1000;

/** The PostgreSQL error the database raised for a failed statement (SQLSTATE + constraint). */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object') {
      const e = current as Record<string, unknown>;
      parts.push(String(e.message ?? ''), JSON.stringify(e.meta ?? {}), String(e.code ?? ''));
      current = e.cause;
    } else break;
  }
  return parts.join(' | ');
}

async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'statement should have been rejected').toBeDefined();
  expect(describeError(caught)).toMatch(pattern);
}

describe('identity data model (real PostgreSQL)', () => {
  let db: PrismaClient;
  let seq = 0;
  const email = (local = 'person') => `${local}.${Date.now()}.${++seq}@example.test`;
  const newUser = (address = email()) => db.user.create({ data: { email: address } });

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('creates the identity tables with the agreed column types', async () => {
    const rows = await db.$queryRaw<
      { table_name: string; column_name: string; udt_name: string }[]
    >`
      SELECT table_name, column_name, udt_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('users','user_profiles','user_preferences','user_password_credentials','user_sessions','user_tokens')`;
    const type = (t: string, c: string) =>
      rows.find((r) => r.table_name === t && r.column_name === c)?.udt_name;
    expect(new Set(rows.map((r) => r.table_name)).size).toBe(6);
    expect(type('users', 'id')).toBe('uuid');
    expect(type('users', 'email')).toBe('citext');
    expect(type('user_tokens', 'email')).toBe('citext');
    expect(type('user_sessions', 'token_hash')).toBe('bytea');
    expect(type('user_tokens', 'token_hash')).toBe('bytea');
    // Every instant is timestamptz (ADR-0006).
    for (const r of rows.filter((x) => x.column_name.endsWith('_at'))) {
      expect(r.udt_name, `${r.table_name}.${r.column_name}`).toBe('timestamptz');
    }
    // No column can hold a plaintext token or password under an obvious name.
    expect(rows.map((r) => r.column_name)).not.toContain('token');
    expect(rows.map((r) => r.column_name)).not.toContain('password');
  });

  it('generates UUIDv7 ids in the application and sets timestamps', async () => {
    const before = Date.now();
    const user = await newUser();
    expect(user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // The first 48 bits of a UUIDv7 are the creation time in ms.
    const ms = Number.parseInt(user.id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(Date.now() + 1000);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.deletedAt).toBeNull();
    expect(user.emailVerifiedAt).toBeNull();
  });

  describe('users.email', () => {
    it('is unique case-insensitively (citext)', async () => {
      const address = email('Case');
      await newUser(address);
      await expectRejected(newUser(address.toUpperCase()), /P2002|users_email_key|23505/);
      const found = await db.user.findUnique({ where: { email: address.toLowerCase() } });
      expect(found?.email).toBe(address);
    });

    it('stays reserved while an account is soft-deleted', async () => {
      const address = email('deleted');
      await db.user.create({ data: { email: address, deletedAt: new Date() } });
      await expectRejected(newUser(address), /P2002|users_email_key|23505/);
    });

    it.each([
      ['surrounding whitespace', ' spaced@example.test'],
      ['no @', 'not-an-address'],
      ['@ first', '@example.test'],
      ['too long', `${'a'.repeat(250)}@x.io`],
      ['too short', 'a@'],
    ])('rejects %s', async (_label, value) => {
      await expectRejected(newUser(value), /users_email_check|23514/);
    });
  });

  it('allows at most one profile, preference and password credential per user', async () => {
    const user = await newUser();
    await db.userProfile.create({ data: { userId: user.id, displayName: 'سارا' } });
    await db.userPreference.create({
      data: { userId: user.id, locale: 'fa', timezone: 'Asia/Tehran' },
    });
    await db.userPasswordCredential.create({
      data: { userId: user.id, passwordHash: ARGON2ID_EXAMPLE },
    });
    await expectRejected(db.userProfile.create({ data: { userId: user.id } }), /P2002|23505/);
    await expectRejected(
      db.userPreference.create({ data: { userId: user.id, locale: 'en', timezone: 'UTC' } }),
      /P2002|23505/,
    );
    await expectRejected(
      db.userPasswordCredential.create({
        data: { userId: user.id, passwordHash: ARGON2ID_EXAMPLE },
      }),
      /P2002|23505/,
    );
    const pref = await db.userPreference.findUniqueOrThrow({ where: { userId: user.id } });
    expect(pref.theme).toBe('dark');
  });

  it('validates profile and preference values', async () => {
    const user = await newUser();
    await expectRejected(
      db.userProfile.create({ data: { userId: user.id, displayName: '' } }),
      /user_profiles_display_name_check|23514/,
    );
    await expectRejected(
      db.userProfile.create({ data: { userId: user.id, displayName: 'x'.repeat(101) } }),
      /user_profiles_display_name_check|23514/,
    );
    await expectRejected(
      db.userPreference.create({ data: { userId: user.id, locale: 'en', timezone: '' } }),
      /user_preferences_timezone_check|23514/,
    );
    await expectRejected(
      db.$executeRaw`INSERT INTO user_preferences (user_id, locale, timezone, updated_at)
                     VALUES (${user.id}::uuid, 'de', 'UTC', now())`,
      /invalid input value for enum|22P02/,
    );
  });

  it('stores only Argon2id password hashes', async () => {
    const user = await newUser();
    for (const value of [
      'correct horse battery staple',
      '$2b$12$abcdefghijklmnopqrstuv',
      '$argon2i$v=19$m=1,t=1,p=1$a$b',
    ]) {
      await expectRejected(
        db.userPasswordCredential.create({ data: { userId: user.id, passwordHash: value } }),
        /user_password_credentials_password_hash_check|23514/,
      );
    }
  });

  describe('sessions', () => {
    it('store a 32-byte token hash, unique, never the token', async () => {
      const user = await newUser();
      const { token, hash } = issueSecretToken();
      const session = await db.userSession.create({
        data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + 30 * DAY) },
      });
      expect(Buffer.from(session.tokenHash).equals(Buffer.from(hash))).toBe(true);
      const [raw] = await db.$queryRaw<{ row: string }[]>`
        SELECT row_to_json(s)::text AS row FROM user_sessions s WHERE id = ${session.id}::uuid`;
      expect(raw?.row).not.toContain(token);

      await expectRejected(
        db.userSession.create({
          data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + DAY) },
        }),
        /P2002|user_sessions_token_hash_key|23505/,
      );
      await expectRejected(
        db.userSession.create({
          data: {
            userId: user.id,
            tokenHash: hash.slice(0, 31),
            expiresAt: new Date(Date.now() + DAY),
          },
        }),
        /user_sessions_token_hash_check|23514/,
      );
    });

    it('must expire after creation and record why they were revoked', async () => {
      const user = await newUser();
      await expectRejected(
        db.userSession.create({
          data: {
            userId: user.id,
            tokenHash: issueSecretToken().hash,
            expiresAt: new Date(Date.now() - DAY),
          },
        }),
        /user_sessions_expires_at_check|23514/,
      );
      await expectRejected(
        db.userSession.create({
          data: {
            userId: user.id,
            tokenHash: issueSecretToken().hash,
            expiresAt: new Date(Date.now() + DAY),
            revokedAt: new Date(),
          },
        }),
        /user_sessions_revoked_check|23514/,
      );
      const revoked = await db.userSession.create({
        data: {
          userId: user.id,
          tokenHash: issueSecretToken().hash,
          expiresAt: new Date(Date.now() + DAY),
          revokedAt: new Date(),
          revokedReason: 'sign_out',
        },
      });
      expect(revoked.revokedReason).toBe('sign_out');
    });

    it('cannot belong to a user that does not exist', async () => {
      await expectRejected(
        db.userSession.create({
          data: {
            userId: '01900000-0000-7000-8000-000000000000',
            tokenHash: issueSecretToken().hash,
            expiresAt: new Date(Date.now() + DAY),
          },
        }),
        /P2003|user_sessions_user_id_fkey|23503/,
      );
    });
  });

  describe('single-use tokens', () => {
    it('require the address for email verification and a valid hash', async () => {
      const user = await newUser();
      const expiresAt = new Date(Date.now() + DAY);
      await expectRejected(
        db.userToken.create({
          data: {
            userId: user.id,
            purpose: 'email_verification',
            tokenHash: issueSecretToken().hash,
            expiresAt,
          },
        }),
        /user_tokens_email_check|23514/,
      );
      const verification = await db.userToken.create({
        data: {
          userId: user.id,
          purpose: 'email_verification',
          email: user.email,
          tokenHash: issueSecretToken().hash,
          expiresAt,
        },
      });
      expect(verification.consumedAt).toBeNull();
      await db.userToken.create({
        data: {
          userId: user.id,
          purpose: 'password_reset',
          tokenHash: issueSecretToken().hash,
          expiresAt,
        },
      });
      await expectRejected(
        db.userToken.create({
          data: {
            userId: user.id,
            purpose: 'password_reset',
            tokenHash: verification.tokenHash,
            expiresAt,
          },
        }),
        /P2002|user_tokens_token_hash_key|23505/,
      );
      await expectRejected(
        db.userToken.create({
          data: {
            userId: user.id,
            purpose: 'password_reset',
            tokenHash: new Uint8Array(64),
            expiresAt,
          },
        }),
        /user_tokens_token_hash_check|23514/,
      );
    });
  });

  it('hard-deleting a user removes everything that belongs to it', async () => {
    const user = await newUser();
    const expiresAt = new Date(Date.now() + DAY);
    await db.userProfile.create({ data: { userId: user.id } });
    await db.userPreference.create({ data: { userId: user.id, locale: 'en', timezone: 'UTC' } });
    await db.userPasswordCredential.create({
      data: { userId: user.id, passwordHash: ARGON2ID_EXAMPLE },
    });
    await db.userSession.create({
      data: { userId: user.id, tokenHash: issueSecretToken().hash, expiresAt },
    });
    await db.userToken.create({
      data: {
        userId: user.id,
        purpose: 'password_reset',
        tokenHash: issueSecretToken().hash,
        expiresAt,
      },
    });
    await db.user.delete({ where: { id: user.id } });
    const where = { userId: user.id };
    const counts = await Promise.all([
      db.userProfile.count({ where }),
      db.userPreference.count({ where }),
      db.userPasswordCredential.count({ where }),
      db.userSession.count({ where }),
      db.userToken.count({ where }),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('identity migration upgrade path (real PostgreSQL)', () => {
  const name = throwawayDatabaseName();
  const upgradeUrl = withDatabase(databaseUrl, name);
  let admin: PrismaClient;
  let workDir: string;

  beforeAll(async () => {
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    workDir = mkdtempSync(join(tmpdir(), 'habit-migrate-'));
  });

  afterAll(async () => {
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.$disconnect();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('applies the newest migration on top of a database at the previous release', () => {
    // State before this change: every migration except the newest, applied with a config that
    // points at a copy of the older migrations (the real migrations folder is never touched).
    const all = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const previous = all.slice(0, -1);
    const oldDir = join(workDir, 'migrations');
    for (const dir of previous)
      cpSync(join(migrationsDir, dir), join(oldDir, dir), { recursive: true });
    cpSync(join(migrationsDir, 'migration_lock.toml'), join(oldDir, 'migration_lock.toml'));
    const config = join(workDir, 'prisma.config.mjs');
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        schema: resolve(apiRoot, 'prisma/schema.prisma'),
        migrations: { path: oldDir },
        datasource: { url: upgradeUrl },
      })};\n`,
    );

    const old = prismaCli(['migrate', 'deploy', '--config', config], upgradeUrl);
    expect(old.code, old.output).toBe(0);
    const pending = prismaCli(['migrate', 'status'], upgradeUrl);
    expect(pending.output).toContain(all.at(-1));

    const upgrade = prismaCli(['migrate', 'deploy'], upgradeUrl);
    expect(upgrade.code, upgrade.output).toBe(0);
    expect(upgrade.output).toContain(all.at(-1));

    const status = prismaCli(['migrate', 'status'], upgradeUrl);
    expect(status.code, status.output).toBe(0);
    expect(status.output).toMatch(/up to date/i);
    const drift = prismaCli(
      [
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      upgradeUrl,
    );
    expect(drift.code, drift.output).toBe(0);
  });
});
