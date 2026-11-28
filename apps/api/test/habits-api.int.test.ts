import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { addDays, localDateAt } from '@habit/habit-engine';
import type { HabitDetail } from '@habit/shared-types';
import { habitCheckInSchema } from '@habit/shared-validation';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { UserDataExportRegistry, UserDataExportService } from '../src/data-export/index.js';
import type { PrismaService } from '../src/database/index.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  HabitCheckInError,
  HabitCheckInService,
  HabitPurgeService,
  HabitRepository,
  HabitScheduleService,
  HabitService,
  HabitsDataExportContributor,
  HabitWriteError,
  toDbDate,
} from '../src/modules/habits/index.js';
import { AccountPurgeService } from '../src/modules/identity/index.js';

// Integration (backlog P3-06, ADR-0032): the habits and categories API through the whole app on a
// real PostgreSQL + Redis — session, CSRF, validation, error envelope, owner scoping (the
// cross-user matrix covers every route), optimistic concurrency, archive / restore / delete /
// undelete / purge, reorder under concurrency, archive racing a check-in, schedule changes over
// HTTP, export contents and the account purge.
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'http://localhost:3000';
const ZONE = 'Asia/Tehran';
const DAY_MS = 86_400_000;

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

describe('habits API (whole API on PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let habits: HabitService;
  let checkIns: HabitCheckInService;
  let seq = 0;
  let ipSeq = 0;
  const freshIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;
  const http = () => request(app.getHttpServer());
  const today = () => localDateAt(new Date(), ZONE);

  async function signedUp(label: string) {
    const email = `habits.api.${label}.${Date.now()}.${++seq}@example.test`;
    await http()
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', freshIp())
      .set('Origin', ORIGIN)
      .send({ email, password: PASSWORD, locale: 'fa', timezone: ZONE })
      .expect(202);
    const res = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .set('Origin', ORIGIN)
      .send({ email, password: PASSWORD })
      .expect(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const { id } = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    return { id, cookie, csrf: res.body.csrfToken as string };
  }
  type Signed = Awaited<ReturnType<typeof signedUp>>;

  /** A request as `who` (session cookie + Origin; CSRF token unless `csrf: false`). */
  const as = (who: Signed, method: Method, path: string, options: { csrf?: boolean } = {}) => {
    const req = http()[method](`/api/v1${path}`).set('Cookie', who.cookie).set('Origin', ORIGIN);
    if (method !== 'get' && options.csrf !== false) req.set('X-CSRF-Token', who.csrf);
    return req;
  };

  const createHabit = async (who: Signed, body: Record<string, unknown> = {}) =>
    (
      await as(who, 'post', '/habits')
        .send({ name: 'Read', type: 'binary', schedule: { kind: 'daily' }, ...body })
        .expect(201)
    ).body as HabitDetail;
  const createCategory = async (who: Signed, name: string) =>
    (await as(who, 'post', '/habit-categories').send({ name }).expect(201)).body as {
      id: string;
      version: number;
      position: number;
    };
  const activeIds = async (who: Signed) =>
    ((await as(who, 'get', '/habits?limit=100').expect(200)).body.data as HabitDetail[]).map(
      (d) => d.habit.id,
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.RATE_LIMIT_PREFIX = `${keyPrefix}habitsapi`;
    process.env.TRUST_PROXY = '1';
    const { AppModule } = await import('../src/app.module.js');
    const { createApp } = await import('../src/app.factory.js');
    const { JsonLogger } = await import('../src/common/logging/json-logger.js');
    const logger = new JsonLogger({
      service: 'api',
      level: 'error',
      format: 'json',
      includeErrorMessages: false,
      write: () => undefined,
    });
    app = await createApp(AppModule, { logger });
    await app.init();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const prisma = db as unknown as PrismaService;
    const schedules = new HabitScheduleService(prisma);
    habits = new HabitService(prisma, new HabitRepository(prisma), schedules);
    checkIns = new HabitCheckInService(prisma);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    delete process.env.TRUST_PROXY;
  });

  it('every route needs a session, and every write the CSRF token', async () => {
    const who = await signedUp('guard');
    const { habit } = await createHabit(who);
    const category = await createCategory(who, 'Guarded');
    const routes: [Method, string][] = [
      ['get', '/habits'],
      ['post', '/habits'],
      ['put', '/habits/order'],
      ['get', `/habits/${habit.id}`],
      ['patch', `/habits/${habit.id}`],
      ['delete', `/habits/${habit.id}`],
      ['post', `/habits/${habit.id}/archive`],
      ['post', `/habits/${habit.id}/restore`],
      ['post', `/habits/${habit.id}/undelete`],
      ['post', `/habits/${habit.id}/schedule-changes`],
      ['get', '/habit-categories'],
      ['post', '/habit-categories'],
      ['put', '/habit-categories/order'],
      ['patch', `/habit-categories/${category.id}`],
      ['delete', `/habit-categories/${category.id}`],
    ];
    for (const [method, path] of routes) {
      const anonymous = await http()[method](`/api/v1${path}`).set('Origin', ORIGIN).send({});
      expect(anonymous.status, `${method} ${path}`).toBe(401);
      expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');
      if (method !== 'get') {
        const res = await as(who, method, path, { csrf: false }).send({});
        expect(res.status, `${method} ${path} without CSRF`).toBe(403);
        expect(res.body.error.code).toBe('CSRF_FAILED');
      }
    }
    // Nothing changed.
    const after = await as(who, 'get', `/habits/${habit.id}`).expect(200);
    expect(after.body.habit.version).toBe(habit.version);
  });

  it('creates every type with its first schedule version, at the end of the list', async () => {
    const who = await signedUp('create');
    const t = today();
    const bodies = [
      { type: 'binary', schedule: { kind: 'weekdays', daysOfWeek: [6, 1] } },
      {
        type: 'numeric',
        unit: 'pages',
        schedule: { kind: 'daily' },
        target: { comparison: 'at_least', value: 10 },
        color: 'teal',
        icon: 'book',
        preferredTime: '07:30',
        description: ' Before bed \r\n ',
      },
      {
        type: 'duration',
        schedule: { kind: 'interval', intervalDays: 2 },
        target: { comparison: 'at_least', value: 1800 },
        startsOn: addDays(t, -5),
      },
      {
        type: 'frequency',
        schedule: { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
      },
      {
        type: 'negative',
        schedule: { kind: 'daily' },
        target: { comparison: 'at_most', value: 0 },
        graceDays: 1,
      },
      {
        type: 'custom',
        unit: 'min',
        schedule: { kind: 'monthly_days', daysOfMonth: [1, -1] },
        target: { comparison: 'at_most', value: 30 },
        endsOn: addDays(t, 60),
      },
    ];
    const created: HabitDetail[] = [];
    for (const body of bodies)
      created.push(await createHabit(who, { name: `H ${body.type}`, ...body }));
    expect(created.map((d) => d.habit.type)).toEqual(bodies.map((b) => b.type));
    expect(created.map((d) => d.habit.position)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const d of created) {
      expect(d.scheduleVersions).toHaveLength(1);
      expect(d.currentVersionId).toBe(d.scheduleVersions[0]!.id);
      expect(d.scheduleVersions[0]!.effectiveFrom).toBe(d.habit.startsOn);
      expect(d.habit).toMatchObject({ version: 1, archivedAt: null, deletedAt: null });
    }
    // Defaults: start = today in the profile zone; interval anchored on the start.
    expect(created[0]!.habit.startsOn).toBe(t);
    expect(created[1]!.habit).toMatchObject({
      unit: 'pages',
      color: 'teal',
      icon: 'book',
      preferredTime: '07:30',
      description: 'Before bed',
    });
    expect(created[2]!.scheduleVersions[0]!.schedule).toEqual({
      kind: 'interval',
      intervalDays: 2,
      anchorDate: addDays(t, -5),
    });
    expect(created[4]!.scheduleVersions[0]).toMatchObject({
      graceDays: 1,
      weekStart: 'saturday',
      calendar: 'solar_hijri',
    });
    // The create is in the schedule audit trail.
    expect(await db.habitScheduleChange.count({ where: { habitId: created[0]!.habit.id } })).toBe(
      1,
    );

    const invalid = await as(who, 'post', '/habits')
      .send({ name: 'H', type: 'numeric', schedule: { kind: 'daily' } })
      .expect(400);
    expect(invalid.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { issues: [{ field: 'body.target' }] },
    });
    const ends = await as(who, 'post', '/habits')
      .send({ name: 'H', type: 'binary', schedule: { kind: 'daily' }, endsOn: addDays(t, -1) })
      .expect(400);
    expect(ends.body.error.details.issues[0].field).toBe('body.endsOn');
    expect(
      (
        await as(who, 'post', '/habits')
          .send({ name: 'H', type: 'binary', schedule: { kind: 'daily' }, goalId: randomUUID() })
          .expect(400)
      ).body.error.code,
    ).toBe('VALIDATION_FAILED');
  });

  it('lists active habits by default, filters by status and category, pages by cursor', async () => {
    const who = await signedUp('list');
    const health = await createCategory(who, 'Health');
    const a = await createHabit(who, { name: 'A', categoryId: health.id });
    const b = await createHabit(who, { name: 'B' });
    const c = await createHabit(who, { name: 'C', categoryId: health.id });
    const d = await createHabit(who, { name: 'D' });
    await as(who, 'post', `/habits/${b.habit.id}/archive`).expect(200);
    await as(who, 'delete', `/habits/${d.habit.id}`).expect(204);

    const names = (res: request.Response) =>
      (res.body.data as HabitDetail[]).map((x) => x.habit.name);
    expect(names(await as(who, 'get', '/habits').expect(200))).toEqual(['A', 'C']);
    expect(names(await as(who, 'get', '/habits?status=archived').expect(200))).toEqual(['B']);
    expect(names(await as(who, 'get', '/habits?status=deleted').expect(200))).toEqual(['D']);
    expect(names(await as(who, 'get', `/habits?categoryId=${health.id}`).expect(200))).toEqual([
      'A',
      'C',
    ]);
    expect(
      names(await as(who, 'get', '/habits?categoryId=none&status=archived').expect(200)),
    ).toEqual(['B']);
    expect(names(await as(who, 'get', `/habits?categoryId=${randomUUID()}`).expect(200))).toEqual(
      [],
    );

    const first = await as(who, 'get', '/habits?limit=1').expect(200);
    expect(first.body.page).toMatchObject({ hasMore: true, limit: 1 });
    expect(names(first)).toEqual(['A']);
    const second = await as(
      who,
      'get',
      `/habits?limit=1&cursor=${first.body.page.nextCursor}`,
    ).expect(200);
    expect(names(second)).toEqual(['C']);
    expect(second.body.page).toEqual({ nextCursor: null, hasMore: false, limit: 1 });
    expect((await as(who, 'get', '/habits?cursor=garbage!').expect(400)).body.error.code).toBe(
      'INVALID_CURSOR',
    );
    expect((await as(who, 'get', '/habits?status=all').expect(400)).body.error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(a.habit.id).not.toBe(c.habit.id);
  });

  it('edits metadata with optimistic concurrency; no-op edits never conflict', async () => {
    const who = await signedUp('edit');
    const category = await createCategory(who, 'Mind');
    const { habit } = await createHabit(who, {
      type: 'numeric',
      schedule: { kind: 'daily' },
      target: { comparison: 'at_least', value: 5 },
    });

    const edited = await as(who, 'patch', `/habits/${habit.id}`)
      .send({
        name: 'Read more',
        unit: 'pages',
        categoryId: category.id,
        color: 'violet',
        preferredTime: '21:00',
        expectedVersion: 1,
      })
      .expect(200);
    expect(edited.body.habit).toMatchObject({
      name: 'Read more',
      unit: 'pages',
      categoryId: category.id,
      color: 'violet',
      preferredTime: '21:00',
      version: 2,
    });
    // Same values again with a stale version: nothing to change, so no conflict and no bump.
    const same = await as(who, 'patch', `/habits/${habit.id}`)
      .send({ name: 'Read more', color: 'violet', expectedVersion: 1 })
      .expect(200);
    expect(same.body.habit.version).toBe(2);
    expect(same.body.habit.updatedAt).toBe(edited.body.habit.updatedAt);
    // A real change with a stale version conflicts and reports the current one.
    const stale = await as(who, 'patch', `/habits/${habit.id}`)
      .send({ name: 'X', expectedVersion: 1 })
      .expect(409);
    expect(stale.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2 },
    });
    // Without expectedVersion, last write wins; null clears.
    const cleared = await as(who, 'patch', `/habits/${habit.id}`)
      .send({ color: null, categoryId: null })
      .expect(200);
    expect(cleared.body.habit).toMatchObject({ color: null, categoryId: null, version: 3 });

    const binary = await createHabit(who);
    const unit = await as(who, 'patch', `/habits/${binary.habit.id}`)
      .send({ unit: 'x' })
      .expect(400);
    expect(unit.body.error.details.issues[0].field).toBe('body.unit');
    for (const body of [
      { type: 'numeric' },
      { target: null },
      { schedule: { kind: 'daily' } },
      {},
    ]) {
      expect(
        (await as(who, 'patch', `/habits/${habit.id}`).send(body).expect(400)).body.error.code,
      ).toBe('VALIDATION_FAILED');
    }
  });

  it('moves start and end dates only where no recorded day falls outside them', async () => {
    const who = await signedUp('dates');
    const t = today();
    const { habit } = await createHabit(who, { startsOn: addDays(t, -10) });
    // Earlier start: the first version follows.
    const earlier = await as(who, 'patch', `/habits/${habit.id}`)
      .send({ startsOn: addDays(t, -20) })
      .expect(200);
    expect(earlier.body.habit.startsOn).toBe(addDays(t, -20));
    expect(earlier.body.scheduleVersions[0].effectiveFrom).toBe(addDays(t, -20));

    await checkIns.checkIn(
      who.id,
      habit.id,
      habitCheckInSchema.parse({
        operationId: randomUUID(),
        localDate: addDays(t, -3),
        action: 'set',
        value: 1,
      }),
    );
    const later = await as(who, 'patch', `/habits/${habit.id}`)
      .send({ startsOn: addDays(t, -2) })
      .expect(409);
    expect(later.body.error).toMatchObject({
      code: 'HABIT_DATES_CONFLICT',
      details: { reason: 'records_outside_dates', recordedDays: 1 },
    });
    const end = await as(who, 'patch', `/habits/${habit.id}`)
      .send({ endsOn: addDays(t, -4) })
      .expect(409);
    expect(end.body.error.code).toBe('HABIT_DATES_CONFLICT');
    await as(who, 'patch', `/habits/${habit.id}`)
      .send({ startsOn: addDays(t, -3), endsOn: addDays(t, 30) })
      .expect(200);
    const order = await as(who, 'patch', `/habits/${habit.id}`)
      .send({ endsOn: addDays(t, -5) })
      .expect(400);
    expect(order.body.error.details.issues[0].field).toBe('body.endsOn');

    // A later start may not swallow a later schedule version.
    const versioned = await createHabit(who, { startsOn: addDays(t, -10) });
    await as(who, 'post', `/habits/${versioned.habit.id}/schedule-changes`)
      .send({ schedule: { kind: 'weekdays', daysOfWeek: [1] }, target: null, graceDays: 0 })
      .expect(200);
    const swallowed = await as(who, 'patch', `/habits/${versioned.habit.id}`)
      .send({ startsOn: t })
      .expect(409);
    expect(swallowed.body.error.details.reason).toBe('schedule_versions');
  });

  it('archive and restore are idempotent, take the row lock and move a restored habit to the end', async () => {
    const who = await signedUp('archive');
    const t = today();
    const first = await createHabit(who, { startsOn: addDays(t, -3) });
    await createHabit(who, { name: 'Second' });
    const archived = await as(
      who,
      'post',
      `/habits/${first.habit.id}/archive?expectedVersion=1`,
    ).expect(200);
    expect(archived.body.habit.archivedAt).not.toBeNull();
    expect(archived.body.habit.version).toBe(2);
    const again = await as(
      who,
      'post',
      `/habits/${first.habit.id}/archive?expectedVersion=1`,
    ).expect(200);
    expect(again.body.habit.version).toBe(2);
    const refused = await as(who, 'post', `/habits/${first.habit.id}/check-ins`)
      .send({ operationId: randomUUID(), localDate: t, action: 'set', value: 1 })
      .expect(409);
    expect(refused.body.error.code).toBe('HABIT_ARCHIVED');
    expect(
      (await as(who, 'post', `/habits/${first.habit.id}/restore?expectedVersion=1`).expect(409))
        .body.error.code,
    ).toBe('VERSION_CONFLICT');
    const restored = await as(who, 'post', `/habits/${first.habit.id}/restore`).expect(200);
    expect(restored.body.habit).toMatchObject({ archivedAt: null, version: 3, position: 2 });
    expect(
      (await as(who, 'post', `/habits/${first.habit.id}/restore`).expect(200)).body.habit.version,
    ).toBe(3);
    expect(
      (await as(who, 'get', '/habits').expect(200)).body.data.map((d: HabitDetail) => d.habit.name),
    ).toEqual(['Second', 'Read']);
    expect(
      (await as(who, 'post', `/habits/${first.habit.id}/archive?expectedVersion=x`).expect(400))
        .body.error.code,
    ).toBe('VALIDATION_FAILED');
  });

  it('an archive and a check-in of the same habit never interleave', async () => {
    const who = await signedUp('race');
    const t = today();
    for (let round = 0; round < 8; round++) {
      const { habit } = await createHabit(who, { startsOn: addDays(t, -3), name: `Race ${round}` });
      const [checkIn, archive] = await Promise.allSettled([
        checkIns.checkIn(
          who.id,
          habit.id,
          habitCheckInSchema.parse({
            operationId: randomUUID(),
            localDate: t,
            action: 'set',
            value: 1,
          }),
        ),
        habits.archive(who.id, habit.id),
      ]);
      expect(archive.status).toBe('fulfilled');
      const record = await db.habitOccurrence.findUnique({
        where: { habitId_localDate: { habitId: habit.id, localDate: toDbDate(t) } },
      });
      if (checkIn.status === 'fulfilled') {
        // The check-in committed first (before the archive took the lock): its record exists.
        expect(record).not.toBeNull();
        expect(await db.habitCheckIn.count({ where: { habitId: habit.id } })).toBe(1);
      } else {
        expect(checkIn.reason).toBeInstanceOf(HabitCheckInError);
        expect((checkIn.reason as HabitCheckInError).code).toBe('HABIT_ARCHIVED');
        expect(record).toBeNull();
      }
    }
  });

  it('delete is soft and restorable for 30 days; the purge then erases the habit and its history', async () => {
    const who = await signedUp('delete');
    const t = today();
    const { habit } = await createHabit(who, { startsOn: addDays(t, -3) });
    await as(who, 'post', `/habits/${habit.id}/check-ins`)
      .send({ operationId: randomUUID(), localDate: t, action: 'set', value: 1 })
      .expect(200);
    expect(
      (await as(who, 'delete', `/habits/${habit.id}?expectedVersion=9`).expect(409)).body.error
        .code,
    ).toBe('VERSION_CONFLICT');
    await as(who, 'delete', `/habits/${habit.id}?expectedVersion=1`).expect(204);
    await as(who, 'delete', `/habits/${habit.id}`).expect(204); // again: no-op
    await as(who, 'get', `/habits/${habit.id}`).expect(404);
    await as(who, 'patch', `/habits/${habit.id}`).send({ name: 'x' }).expect(404);
    await as(who, 'post', `/habits/${habit.id}/archive`).expect(404);
    await as(who, 'get', `/habits/${habit.id}/statuses?from=${t}&to=${t}`).expect(404);
    const listed = await as(who, 'get', '/habits?status=deleted').expect(200);
    expect(listed.body.data[0].habit).toMatchObject({ id: habit.id, version: 2 });
    expect(listed.body.data[0].habit.deletedAt).not.toBeNull();

    const back = await as(who, 'post', `/habits/${habit.id}/undelete`).expect(200);
    expect(back.body.habit).toMatchObject({ deletedAt: null, version: 3 });
    expect(
      (await as(who, 'post', `/habits/${habit.id}/undelete`).expect(200)).body.habit.version,
    ).toBe(3);

    // Past the window: gone for the API; the purge erases it with versions, records and log.
    await as(who, 'delete', `/habits/${habit.id}`).expect(204);
    await db.habit.update({
      where: { id: habit.id },
      data: { deletedAt: new Date(Date.now() - 31 * DAY_MS) },
    });
    await as(who, 'post', `/habits/${habit.id}/undelete`).expect(404);
    await as(who, 'delete', `/habits/${habit.id}`).expect(404);
    expect((await as(who, 'get', '/habits?status=deleted').expect(200)).body.data).toEqual([]);
    const recent = await createHabit(who, { name: 'Recent' });
    await as(who, 'delete', `/habits/${recent.habit.id}`).expect(204);
    const purged = await new HabitPurgeService(db as unknown as PrismaService).purge(new Date(), 1);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await db.habit.count({ where: { id: habit.id } })).toBe(0);
    expect(await db.habitScheduleVersion.count({ where: { habitId: habit.id } })).toBe(0);
    expect(await db.habitScheduleChange.count({ where: { habitId: habit.id } })).toBe(0);
    expect(await db.habitOccurrence.count({ where: { habitId: habit.id } })).toBe(0);
    expect(await db.habitCheckIn.count({ where: { habitId: habit.id } })).toBe(0);
    expect(await db.habit.count({ where: { id: recent.habit.id } })).toBe(1); // still in its window
  });

  it('reorders deterministically; stale or foreign lists are refused', async () => {
    const who = await signedUp('reorder');
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C', 'D']) ids.push((await createHabit(who, { name })).habit.id);
    const [a, b, c, d] = ids as [string, string, string, string];
    const res = await as(who, 'put', '/habits/order')
      .send({ habitIds: [c, a, d, b] })
      .expect(200);
    expect(res.body.data.map((h: { id: string; position: number }) => [h.id, h.position])).toEqual([
      [c, 0],
      [a, 1],
      [d, 2],
      [b, 3],
    ]);
    // The same order again writes nothing and bumps no version.
    const before = await db.habit.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    await as(who, 'put', '/habits/order')
      .send({ habitIds: [c, a, d, b] })
      .expect(200);
    const after = await db.habit.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    expect(after.map((h) => h.updatedAt.getTime())).toEqual(
      before.map((h) => h.updatedAt.getTime()),
    );
    expect(after.every((h) => h.version === 1)).toBe(true);

    const missing = await as(who, 'put', '/habits/order')
      .send({ habitIds: [a, b, c] })
      .expect(409);
    expect(missing.body.error).toMatchObject({
      code: 'ORDER_MISMATCH',
      details: { expected: 4, received: 3 },
    });
    await as(who, 'post', `/habits/${d}/archive`).expect(200);
    expect(
      (
        await as(who, 'put', '/habits/order')
          .send({ habitIds: [a, b, c, d] })
          .expect(409)
      ).body.error.code,
    ).toBe('ORDER_MISMATCH');
    expect(
      (
        await as(who, 'put', '/habits/order')
          .send({ habitIds: [a, b, randomUUID()] })
          .expect(404)
      ).body.error.code,
    ).toBe('NOT_FOUND');
    expect(
      (
        await as(who, 'put', '/habits/order')
          .send({ habitIds: [a, a, b] })
          .expect(400)
      ).body.error.code,
    ).toBe('VALIDATION_FAILED');
  });

  it('concurrent reorders apply one after the other: the result is exactly one submitted order', async () => {
    const who = await signedUp('reorder-race');
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await createHabit(who, { name: `H${i}` })).habit.id);
    const orders = Array.from({ length: 8 }, (_, k) =>
      [...ids].sort((x, y) => ((ids.indexOf(x) * (k + 3)) % 7) - ((ids.indexOf(y) * (k + 3)) % 7)),
    );
    const results = await Promise.all(
      orders.map((order) => as(who, 'put', '/habits/order').send({ habitIds: order })),
    );
    expect(results.map((r) => r.status)).toEqual(orders.map(() => 200));
    const final = await activeIds(who);
    expect(orders.map((o) => o.join())).toContain(final.join());
    const positions = (
      await db.habit.findMany({ where: { userId: who.id }, select: { position: true } })
    )
      .map((h) => h.position)
      .sort((x, y) => x - y);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5]);

    // A reorder racing a create either sees the new habit (and is refused) or places it last.
    const [reorder, created] = await Promise.all([
      habits.reorder(who.id, [...final].reverse()).catch((e: unknown) => e),
      createHabit(who, { name: 'Late' }),
    ]);
    const now = await activeIds(who);
    expect(now.at(-1)).toBe(created.habit.id);
    if (reorder instanceof HabitWriteError) expect(reorder.code).toBe('ORDER_MISMATCH');
    else expect(now.slice(0, -1)).toEqual([...final].reverse());
  });

  it('changes a schedule over HTTP through the versioning rules', async () => {
    const who = await signedUp('schedule');
    const t = today();
    const { habit } = await createHabit(who, { startsOn: addDays(t, -10) });
    const split = await as(who, 'post', `/habits/${habit.id}/schedule-changes`)
      .send({
        schedule: { kind: 'weekdays', daysOfWeek: [1, 3, 5] },
        target: null,
        graceDays: 1,
        expectedHabitVersion: 1,
      })
      .expect(200);
    expect(split.body.outcome).toBe('split');
    expect(split.body.detail.scheduleVersions).toHaveLength(2);
    expect(split.body.detail.currentVersionId).toBe(split.body.detail.scheduleVersions[1].id);
    expect(split.body.detail.habit.version).toBe(2);
    expect(split.body.change).toMatchObject({
      operation: 'split',
      effectiveFrom: t,
      isCorrection: false,
    });
    const unchanged = await as(who, 'post', `/habits/${habit.id}/schedule-changes`)
      .send({ schedule: { kind: 'weekdays', daysOfWeek: [5, 3, 1] }, target: null, graceDays: 1 })
      .expect(200);
    expect(unchanged.body).toMatchObject({ outcome: 'unchanged', change: null });
    const reason = await as(who, 'post', `/habits/${habit.id}/schedule-changes`)
      .send({
        schedule: { kind: 'daily' },
        target: null,
        graceDays: 0,
        effectiveFrom: addDays(t, -5),
      })
      .expect(400);
    expect(reason.body.error.details.issues[0].field).toBe('body.reason');
    const early = await as(who, 'post', `/habits/${habit.id}/schedule-changes`)
      .send({
        schedule: { kind: 'daily' },
        target: null,
        graceDays: 0,
        effectiveFrom: addDays(t, -30),
        reason: 'fix',
      })
      .expect(400);
    expect(early.body.error.details.issues[0].field).toBe('body.effectiveFrom');
    const rules = await as(who, 'post', `/habits/${habit.id}/schedule-changes`)
      .send({
        schedule: { kind: 'daily' },
        target: { comparison: 'at_least', value: 2 },
        graceDays: 0,
      })
      .expect(400);
    expect(rules.body.error.details.issues[0].field).toBe('body.target');
    expect(
      (
        await as(who, 'post', `/habits/${habit.id}/schedule-changes`)
          .send({
            schedule: { kind: 'daily' },
            target: null,
            graceDays: 0,
            expectedHabitVersion: 1,
          })
          .expect(409)
      ).body.error.code,
    ).toBe('VERSION_CONFLICT');
  });

  it('categories: create, rename, recolour, reorder; names unique; non-empty ones are kept', async () => {
    const who = await signedUp('categories');
    const health = await createCategory(who, 'Health');
    const work = await createCategory(who, 'Work');
    expect([health.position, work.position]).toEqual([0, 1]);
    expect(
      (await as(who, 'post', '/habit-categories').send({ name: ' health ' }).expect(409)).body.error
        .code,
    ).toBe('CATEGORY_NAME_TAKEN');
    const renamed = await as(who, 'patch', `/habit-categories/${health.id}`)
      .send({ name: 'Body', color: 'green', expectedVersion: 1 })
      .expect(200);
    expect(renamed.body).toMatchObject({ name: 'Body', color: 'green', version: 2 });
    expect(
      (
        await as(who, 'patch', `/habit-categories/${health.id}`)
          .send({ color: 'green', expectedVersion: 1 })
          .expect(200)
      ).body.version,
    ).toBe(2);
    expect(
      (
        await as(who, 'patch', `/habit-categories/${health.id}`)
          .send({ color: 'red', expectedVersion: 1 })
          .expect(409)
      ).body.error,
    ).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 2 } });
    expect(
      (await as(who, 'patch', `/habit-categories/${work.id}`).send({ name: 'BODY' }).expect(409))
        .body.error.code,
    ).toBe('CATEGORY_NAME_TAKEN');

    const order = await as(who, 'put', '/habit-categories/order')
      .send({ categoryIds: [work.id, health.id] })
      .expect(200);
    expect(order.body.data.map((c: { id: string }) => c.id)).toEqual([work.id, health.id]);
    expect(
      (
        await as(who, 'put', '/habit-categories/order')
          .send({ categoryIds: [work.id] })
          .expect(409)
      ).body.error.code,
    ).toBe('ORDER_MISMATCH');
    const listed = await as(who, 'get', '/habit-categories').expect(200);
    expect(listed.body.data.map((c: { name: string }) => c.name)).toEqual(['Work', 'Body']);

    // Active or archived habits keep a category; deleted ones are detached.
    const active = await createHabit(who, { categoryId: health.id });
    const archived = await createHabit(who, { categoryId: health.id });
    const deleted = await createHabit(who, { categoryId: health.id });
    await as(who, 'post', `/habits/${archived.habit.id}/archive`).expect(200);
    await as(who, 'delete', `/habits/${deleted.habit.id}`).expect(204);
    const full = await as(who, 'delete', `/habit-categories/${health.id}`).expect(409);
    expect(full.body.error).toMatchObject({
      code: 'CATEGORY_NOT_EMPTY',
      details: { habitCount: 2 },
    });
    await as(who, 'patch', `/habits/${active.habit.id}`).send({ categoryId: null }).expect(200);
    await as(who, 'delete', `/habits/${archived.habit.id}`).expect(204);
    expect(
      (await as(who, 'delete', `/habit-categories/${health.id}?expectedVersion=1`).expect(409)).body
        .error.code,
    ).toBe('VERSION_CONFLICT');
    await as(who, 'delete', `/habit-categories/${health.id}`).expect(204);
    await as(who, 'delete', `/habit-categories/${health.id}`).expect(404);
    const back = await as(who, 'post', `/habits/${deleted.habit.id}/undelete`).expect(200);
    expect(back.body.habit.categoryId).toBeNull();
  });

  it('another user’s habits and categories answer 404 on every route', async () => {
    const [owner, other] = [await signedUp('owner'), await signedUp('intruder')];
    const t = today();
    const category = await createCategory(owner, 'Private');
    const { habit } = await createHabit(owner, {
      startsOn: addDays(t, -2),
      categoryId: category.id,
    });
    const deleted = await createHabit(owner, { name: 'Deleted' });
    await as(owner, 'delete', `/habits/${deleted.habit.id}`).expect(204);
    const mine = await createHabit(other, { name: 'Mine' });
    const ownersBefore = await db.habit.findMany({
      where: { userId: owner.id },
      orderBy: { id: 'asc' },
    });

    const matrix: [Method, string, object?][] = [
      ['get', `/habits/${habit.id}`],
      ['patch', `/habits/${habit.id}`, { name: 'Pwned' }],
      ['delete', `/habits/${habit.id}`],
      ['post', `/habits/${habit.id}/archive`],
      ['post', `/habits/${habit.id}/restore`],
      ['post', `/habits/${deleted.habit.id}/undelete`],
      [
        'post',
        `/habits/${habit.id}/schedule-changes`,
        { schedule: { kind: 'daily' }, target: null, graceDays: 0 },
      ],
      [
        'post',
        `/habits/${habit.id}/check-ins`,
        { operationId: randomUUID(), localDate: t, action: 'set', value: 1 },
      ],
      ['get', `/habits/${habit.id}/statuses?from=${t}&to=${t}`],
      ['put', '/habits/order', { habitIds: [mine.habit.id, habit.id] }],
      [
        'post',
        '/habits',
        { name: 'X', type: 'binary', schedule: { kind: 'daily' }, categoryId: category.id },
      ],
      ['patch', `/habits/${mine.habit.id}`, { categoryId: category.id }],
      ['patch', `/habit-categories/${category.id}`, { name: 'Pwned' }],
      ['delete', `/habit-categories/${category.id}`],
      ['put', '/habit-categories/order', { categoryIds: [category.id] }],
    ];
    for (const [method, path, body] of matrix) {
      const res = await as(other, method, path).send(body ?? {});
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    // Lists never show them, even filtered by the owner's category.
    const lists = [
      '/habits',
      '/habits?status=archived',
      '/habits?status=deleted',
      `/habits?categoryId=${category.id}`,
      '/habit-categories',
    ];
    for (const path of lists) {
      const ids = (await as(other, 'get', path).expect(200)).body.data.map(
        (x: HabitDetail | { id: string }) => ('habit' in x ? x.habit.id : x.id),
      );
      expect(ids, path).not.toContain(habit.id);
      expect(ids, path).not.toContain(deleted.habit.id);
      expect(ids, path).not.toContain(category.id);
    }
    // Nothing of the owner's changed.
    const ownersAfter = await db.habit.findMany({
      where: { userId: owner.id },
      orderBy: { id: 'asc' },
    });
    expect(ownersAfter).toEqual(ownersBefore);
    expect(await db.habit.count({ where: { userId: other.id } })).toBe(1);
  });

  it('the export carries habits and categories made through the API; the account purge erases them', async () => {
    const who = await signedUp('export');
    const category = await createCategory(who, 'Exported');
    const kept = await createHabit(who, { name: 'Kept', categoryId: category.id, color: 'amber' });
    const gone = await createHabit(who, { name: 'Gone' });
    await as(who, 'delete', `/habits/${gone.habit.id}`).expect(204);
    const registry = new UserDataExportRegistry();
    new HabitsDataExportContributor(registry).onModuleInit();
    const file = await new UserDataExportService(
      db as unknown as PrismaService,
      registry,
    ).exportFor(who.id);
    const section = file.sections.habits as {
      categories: { id: string; name: string }[];
      habits: {
        id: string;
        name: string;
        deletedAt: string | null;
        color: string | null;
        scheduleVersions: unknown[];
      }[];
    };
    expect(section.categories).toEqual([
      expect.objectContaining({ id: category.id, name: 'Exported' }),
    ]);
    expect(section.habits.find((h) => h.id === kept.habit.id)).toMatchObject({
      name: 'Kept',
      color: 'amber',
      deletedAt: null,
      scheduleVersions: [expect.objectContaining({ id: kept.scheduleVersions[0]!.id })],
    });
    expect(section.habits.find((h) => h.id === gone.habit.id)!.deletedAt).not.toBeNull();

    await db.user.update({
      where: { id: who.id },
      data: { deletedAt: new Date(Date.now() - 31 * DAY_MS) },
    });
    await new AccountPurgeService(db as unknown as PrismaService).purgeExpired();
    expect(await db.habit.count({ where: { userId: who.id } })).toBe(0);
    expect(await db.habitCategory.count({ where: { userId: who.id } })).toBe(0);
    expect(await db.habitScheduleVersion.count({ where: { userId: who.id } })).toBe(0);
  });
});
