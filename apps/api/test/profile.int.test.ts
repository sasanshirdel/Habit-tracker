import 'reflect-metadata';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { throwawayDatabaseName, withDatabase } from './integration/database-url.js';
import { prismaCli } from './integration/prisma-cli.js';

// Integration (backlog P2-07, ADR-0024): profile and preferences on real PostgreSQL and Redis
// through the whole API (`createApp` + AppModule: AuthGuard, CSRF, rate limiter, validation, error
// envelope). Rate-limit keys live under this run's prefix.
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');
const apiRoot = resolve(import.meta.dirname, '..');

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'http://localhost:3000'; // CORS_ORIGINS default
let seq = 0;
const uniqueEmail = (label: string) => `profile.${label}.${Date.now()}.${++seq}@example.test`;
let ipSeq = 0;
const freshIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;

interface Signed {
  email: string;
  cookie: string;
  csrf: string;
}

describe('profile and preferences (real PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const lines: string[] = [];
  const http = () => request(app.getHttpServer());

  async function signedUp(
    label: string,
    locale: 'en' | 'fa',
    displayName?: string,
  ): Promise<Signed> {
    const email = uniqueEmail(label);
    await http()
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', freshIp())
      .set('Origin', ORIGIN)
      .send({ email, password: PASSWORD, locale, timezone: 'Asia/Tehran', displayName })
      .expect(202);
    const res = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .set('Origin', ORIGIN)
      .send({ email, password: PASSWORD })
      .expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    return { email, cookie, csrf: res.body.csrfToken as string };
  }
  const get = (path: string, who: Signed) =>
    http().get(`/api/v1/account/${path}`).set('Cookie', who.cookie);
  const patch = (path: string, who: Signed, body: unknown, csrf: string | null = who.csrf) => {
    const req = http()
      .patch(`/api/v1/account/${path}`)
      .set('Cookie', who.cookie)
      .set('Origin', ORIGIN);
    if (csrf !== null) req.set('X-CSRF-Token', csrf);
    return req.send(body as object);
  };
  const userIdOf = async (who: Signed) =>
    (await db.user.findUniqueOrThrow({ where: { email: who.email }, select: { id: true } })).id;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.RATE_LIMIT_PREFIX = `${keyPrefix}profile`;
    process.env.TRUST_PROXY = '1';
    const { AppModule } = await import('../src/app.module.js');
    const { createApp } = await import('../src/app.factory.js');
    const { JsonLogger } = await import('../src/common/logging/json-logger.js');
    const logger = new JsonLogger({
      service: 'api',
      level: 'trace',
      format: 'json',
      includeErrorMessages: false,
      write: (line) => lines.push(line),
    });
    app = await createApp(AppModule, { logger });
    await app.init();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  }, 60_000);

  beforeEach(() => {
    lines.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    delete process.env.TRUST_PROXY;
  });

  it('requires a session for every route', async () => {
    for (const path of ['profile', 'preferences']) {
      const read = await http().get(`/api/v1/account/${path}`).expect(401);
      expect(read.body.error.code).toBe('UNAUTHENTICATED');
      const write = await http()
        .patch(`/api/v1/account/${path}`)
        .set('Origin', ORIGIN)
        .send({ theme: 'light' })
        .expect(401);
      expect(write.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('registration derives calendar and week start from the language', async () => {
    const fa = await signedUp('fa', 'fa', ' سارا ');
    const en = await signedUp('en', 'en');
    expect((await get('preferences', fa).expect(200)).body).toEqual({
      locale: 'fa',
      timezone: 'Asia/Tehran',
      theme: 'dark',
      calendar: 'solar_hijri',
      weekStart: 'saturday',
    });
    expect((await get('preferences', en).expect(200)).body).toMatchObject({
      locale: 'en',
      calendar: 'gregorian',
      weekStart: 'monday',
    });
    expect((await get('profile', fa).expect(200)).body).toEqual({ displayName: 'سارا' });
    expect((await get('profile', en).expect(200)).body).toEqual({ displayName: null });
  });

  it('updates the display name (normalised, blank clears) — CSRF required, own row only', async () => {
    const me = await signedUp('name', 'en');
    const other = await signedUp('name-other', 'fa', 'Other');

    const noCsrf = await patch('profile', me, { displayName: 'Sara' }, null).expect(403);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
    const wrongCsrf = await patch('profile', me, { displayName: 'Sara' }, other.csrf).expect(403);
    expect(wrongCsrf.body.error.code).toBe('CSRF_FAILED');

    const saved = await patch('profile', me, { displayName: '  Ｓａｒａ \u00a0 نیلوفر\u200cها ' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ displayName: 'Sara نیلوفر\u200cها' });
    const row = await db.userProfile.findUniqueOrThrow({ where: { userId: await userIdOf(me) } });
    expect(row.displayName).toBe('Sara نیلوفر\u200cها');
    expect((await get('profile', me).expect(200)).body).toEqual(saved.body);

    expect((await patch('profile', me, { displayName: '   ' }).expect(200)).body).toEqual({
      displayName: null,
    });
    expect((await get('profile', other).expect(200)).body).toEqual({ displayName: 'Other' });
    // The value never reaches a log line.
    expect(lines.join('\n')).not.toContain('نیلوفر');
    expect(lines.join('\n')).not.toContain(me.email);
  });

  it('rejects invalid profile input with the validation envelope', async () => {
    const me = await signedUp('name-invalid', 'en', 'Kept');
    for (const body of [
      {},
      { displayName: 'x'.repeat(101) },
      { displayName: 'evil\u202egnp.exe' },
      { displayName: 'two\nlines' },
      { displayName: 42 },
      { displayName: 'ok', userId: '0195f0b4-0000-7000-8000-000000000000' },
    ]) {
      const res = await patch('profile', me, body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(res.body.error.details.issues)).toBe(true);
    }
    expect((await get('profile', me).expect(200)).body).toEqual({ displayName: 'Kept' });
  });

  it('updates any subset of preferences, leaves the rest and other accounts alone', async () => {
    const me = await signedUp('prefs', 'fa');
    const other = await signedUp('prefs-other', 'fa');
    const meId = await userIdOf(me);
    const eventsBefore = await db.userSecurityEvent.count({ where: { userId: meId } });

    const res = await patch('preferences', me, { theme: 'light', weekStart: 'sunday' }).expect(200);
    expect(res.body).toEqual({
      locale: 'fa',
      timezone: 'Asia/Tehran',
      theme: 'light',
      calendar: 'solar_hijri',
      weekStart: 'sunday',
    });
    const all = await patch('preferences', me, {
      locale: 'en',
      timezone: 'America/Argentina/Buenos_Aires',
      calendar: 'gregorian',
    }).expect(200);
    expect(all.body).toEqual({
      locale: 'en',
      timezone: 'America/Argentina/Buenos_Aires',
      theme: 'light',
      calendar: 'gregorian',
      weekStart: 'sunday',
    });
    const row = await db.userPreference.findUniqueOrThrow({ where: { userId: meId } });
    expect(row).toMatchObject(all.body);
    expect((await get('preferences', other).expect(200)).body).toMatchObject({
      locale: 'fa',
      theme: 'dark',
      calendar: 'solar_hijri',
    });
    // Not security-relevant (ADR-0024): no security event.
    expect(await db.userSecurityEvent.count({ where: { userId: meId } })).toBe(eventsBefore);
  });

  it('rejects invalid preferences with the validation envelope and changes nothing', async () => {
    const me = await signedUp('prefs-invalid', 'en');
    const before = (await get('preferences', me).expect(200)).body;
    for (const body of [
      {},
      { timezone: 'Asia/Atlantis' },
      { timezone: '+03:30' },
      { timezone: 'IRST' },
      { locale: 'de' },
      { theme: 'blue' },
      { calendar: 'persian' },
      { weekStart: 'friday' },
      { theme: 'light', userId: '0195f0b4-0000-7000-8000-000000000000' },
      { theme: null },
    ]) {
      const res = await patch('preferences', me, body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect((await get('preferences', me).expect(200)).body).toEqual(before);
  });
});

describe('profile_preferences migration backfill (real PostgreSQL)', () => {
  const name = throwawayDatabaseName();
  const upgradeUrl = withDatabase(databaseUrl, name);
  const migrationsDir = resolve(apiRoot, 'prisma/migrations');
  const MIGRATION = '20261127120000_profile_preferences';
  let admin: PrismaClient;
  let upgraded: PrismaClient | undefined;
  let workDir: string;

  beforeAll(async () => {
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    workDir = mkdtempSync(join(tmpdir(), 'habit-migrate-p207-'));
  });

  afterAll(async () => {
    await upgraded?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.$disconnect();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('gives existing Persian accounts Solar Hijri / Saturday and English ones Gregorian / Monday', async () => {
    const before = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name < MIGRATION)
      .map((d) => d.name);
    const oldDir = join(workDir, 'migrations');
    for (const dir of before)
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

    // Rows as the previous release wrote them (no calendar/week_start columns yet).
    upgraded = new PrismaClient({ adapter: new PrismaPg({ connectionString: upgradeUrl }) });
    for (const [id, locale] of [
      ['0195f0b4-0000-7000-8000-0000000000fa', 'fa'],
      ['0195f0b4-0000-7000-8000-0000000000e1', 'en'],
    ] as const) {
      await upgraded.$executeRawUnsafe(
        `INSERT INTO users (id, email, updated_at) VALUES ('${id}', '${locale}@example.test', now())`,
      );
      await upgraded.$executeRawUnsafe(
        `INSERT INTO user_preferences (user_id, locale, timezone, updated_at) VALUES ('${id}', '${locale}', 'Asia/Tehran', now())`,
      );
    }

    const upgrade = prismaCli(['migrate', 'deploy'], upgradeUrl);
    expect(upgrade.code, upgrade.output).toBe(0);
    const rows = await upgraded.$queryRawUnsafe<
      { locale: string; calendar: string; week_start: string }[]
    >(
      'SELECT locale::text, calendar::text, week_start::text FROM user_preferences ORDER BY locale',
    );
    expect(rows).toEqual([
      { locale: 'en', calendar: 'gregorian', week_start: 'monday' },
      { locale: 'fa', calendar: 'solar_hijri', week_start: 'saturday' },
    ]);
  });
});
