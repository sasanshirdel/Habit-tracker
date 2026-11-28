import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { addDays, localDateAt } from '@habit/habit-engine';
import {
  habitCheckInSchema,
  habitDefinitionSchema,
  type HabitCheckInInput,
  type HabitDefinitionInput,
} from '@habit/shared-validation';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { UserDataExportRegistry, UserDataExportService } from '../src/data-export/index.js';
import type { PrismaService } from '../src/database/index.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  HabitCheckInError,
  HabitCheckInService,
  HabitNotFoundError,
  HabitRepository,
  HabitScheduleService,
  HabitsDataExportContributor,
  toDbDate,
  type NewHabit,
} from '../src/modules/habits/index.js';
import { AccountPurgeService } from '../src/modules/identity/index.js';
import { throwawayDatabaseName, withDatabase } from './integration/database-url.js';
import { prismaCli } from './integration/prisma-cli.js';

// Integration (backlog P3-04, ADR-0031): check-ins and statuses on a real PostgreSQL — record /
// update / skip / clear per habit type, idempotency by operation id (sequential and concurrent),
// conditional writes by record version, date rules in the user's time zone, owner scoping, the
// append-only log, export and purge, the migration on top of the previous release — and the HTTP
// routes through the whole API (session, CSRF, validation, error envelope).
const databaseUrl = inject('integrationDatabaseUrl');
const redisUrl = inject('integrationRedisUrl');
const keyPrefix = inject('integrationRedisKeyPrefix');
const apiRoot = resolve(import.meta.dirname, '..');

/** 08:00 UTC on 2026-11-28 = 11:30 in Tehran: the user's today is 2026-11-28 (a Saturday). */
const NOW = new Date('2026-11-28T11:30:00+03:30');
const TODAY = '2026-11-28';

describe('check-ins and statuses (real PostgreSQL)', () => {
  let db: PrismaClient;
  let repo: HabitRepository;
  let service: HabitCheckInService;
  let schedules: HabitScheduleService;
  let seq = 0;

  const newUser = async (timezone = 'Asia/Tehran') => {
    const user = await db.user.create({
      data: { email: `checkin.${Date.now()}.${++seq}@example.test` },
    });
    await db.userPreference.create({
      data: { userId: user.id, locale: 'en', timezone, weekStart: 'monday', calendar: 'gregorian' },
    });
    return user;
  };
  const definition = (over: Partial<HabitDefinitionInput> = {}) =>
    habitDefinitionSchema.parse({
      type: 'binary',
      unit: null,
      schedule: { kind: 'daily' },
      target: null,
      graceDays: 0,
      ...over,
    });
  const newHabit = async (userId: string, over: Partial<NewHabit> = {}) =>
    (
      await repo.createHabit(
        userId,
        {
          definition: definition(),
          name: 'Read',
          description: null,
          icon: null,
          color: null,
          categoryId: null,
          startsOn: '2026-11-01',
          endsOn: null,
          preferredTime: null,
          position: 0,
          ...over,
        },
        { now: NOW },
      )
    ).habit;
  const op = (input: Omit<HabitCheckInInput, 'operationId'> & { operationId?: string }) =>
    habitCheckInSchema.parse({ operationId: randomUUID(), ...input });
  const checkIn = (
    userId: string,
    habitId: string,
    input: Parameters<typeof op>[0],
    now: Date = NOW,
  ) => service.checkIn(userId, habitId, op(input), { now });
  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HabitCheckInError) return error.code;
      if (error instanceof HabitNotFoundError) return 'NOT_FOUND';
      throw error;
    }
    return 'resolved';
  }
  const eventsOf = (habitId: string) =>
    db.habitCheckIn.findMany({
      where: { habitId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const recordOf = (habitId: string, localDate: string) =>
    db.habitOccurrence.findUnique({
      where: { habitId_localDate: { habitId, localDate: toDbDate(localDate) } },
    });

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    repo = new HabitRepository(db as unknown as PrismaService);
    service = new HabitCheckInService(db as unknown as PrismaService);
    schedules = new HabitScheduleService(db as unknown as PrismaService);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  describe('recording a day', () => {
    it('set, update, skip and clear — one record per day, its version counts the changes', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id, {
        definition: definition({
          type: 'numeric',
          unit: 'pages',
          target: { comparison: 'at_least', value: 10 },
        }),
      });

      const first = await checkIn(user.id, habit.id, {
        localDate: TODAY,
        action: 'set',
        value: 4.5,
      });
      expect(first).toMatchObject({
        replayed: false,
        checkIn: {
          action: 'set',
          value: 4.5,
          changed: true,
          occurrenceVersion: 1,
          localToday: TODAY,
        },
        occurrence: { localDate: TODAY, value: 4.5, skipped: false, version: 1 },
        day: {
          date: TODAY,
          status: 'due',
          timing: 'today',
          progress: { value: 4.5, met: false, partial: true, percent: 45 },
        },
        period: null,
      });
      // The version in effect that day is derived and reported (never stored, ADR-0028).
      const { scheduleVersions } = (await repo.findHabit(user.id, habit.id))!;
      expect(first.day.versionId).toBe(scheduleVersions[0]!.id);

      const done = await checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value: 12 });
      expect(done.occurrence).toMatchObject({ value: 12, version: 2 });
      expect(done.day.status).toBe('completed');

      const skipped = await checkIn(user.id, habit.id, { localDate: TODAY, action: 'skip' });
      expect(skipped.occurrence).toMatchObject({ value: null, skipped: true, version: 3 });
      expect(skipped.day.status).toBe('skipped');

      const cleared = await checkIn(user.id, habit.id, { localDate: TODAY, action: 'clear' });
      expect(cleared.occurrence).toBeNull();
      expect(cleared.checkIn).toMatchObject({ changed: true, occurrenceVersion: null });
      expect(cleared.day.status).toBe('due');
      expect(await recordOf(habit.id, TODAY)).toBeNull();

      // Clearing again, or setting what is already there, changes nothing but is logged.
      const again = await checkIn(user.id, habit.id, { localDate: TODAY, action: 'clear' });
      expect(again.checkIn.changed).toBe(false);
      await checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value: 3 });
      const same = await checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value: 3 });
      expect(same.checkIn).toMatchObject({ changed: false, occurrenceVersion: 1 });

      const events = await eventsOf(habit.id);
      expect(events.map((e) => [e.action, e.changed])).toEqual([
        ['set', true],
        ['set', true],
        ['skip', true],
        ['clear', true],
        ['clear', false],
        ['set', true],
        ['set', false],
      ]);
    });

    it.each([
      ['binary', definition(), 1, 2],
      [
        'frequency',
        definition({
          type: 'frequency',
          schedule: { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
        }),
        0,
        0.5,
      ],
      [
        'duration',
        definition({ type: 'duration', target: { comparison: 'at_least', value: 600 } }),
        86_400,
        1.5,
      ],
      [
        'negative',
        definition({ type: 'negative', target: { comparison: 'at_most', value: 0 } }),
        3,
        0.5,
      ],
      [
        'custom',
        definition({ type: 'custom', unit: 'km', target: { comparison: 'at_most', value: 5 } }),
        999_999.999,
        null,
      ],
    ] as const)('%s: accepts %s, refuses %s for the type', async (type, def, good, bad) => {
      const user = await newUser();
      const habit = await newHabit(user.id, {
        definition: { ...def, unit: type === 'custom' ? 'km' : null },
      });
      const ok = await checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value: good });
      expect(ok.occurrence?.value).toBe(good);
      if (bad !== null) {
        expect(
          await codeOf(checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value: bad })),
        ).toBe('INVALID_VALUE');
      }
    });

    it('per-type completion through the stored versions', async () => {
      const user = await newUser();
      const negative = await newHabit(user.id, {
        definition: definition({ type: 'negative', target: { comparison: 'at_most', value: 1 } }),
      });
      const within = await checkIn(user.id, negative.id, {
        localDate: '2026-11-27',
        action: 'set',
        value: 1,
      });
      expect(within.day).toMatchObject({ status: 'completed', timing: 'past' });
      const over = await checkIn(user.id, negative.id, {
        localDate: TODAY,
        action: 'set',
        value: 2,
      });
      expect(over.day.status).toBe('missed'); // an "at most" limit exceeded is final at once

      const duration = await newHabit(user.id, {
        definition: definition({
          type: 'duration',
          target: { comparison: 'at_least', value: 600 },
        }),
      });
      expect(
        (await checkIn(user.id, duration.id, { localDate: TODAY, action: 'set', value: 599 })).day
          .progress,
      ).toMatchObject({ met: false, partial: true, percent: 99 });
    });
  });

  describe('idempotency by operation id', () => {
    it('a retry is replayed from the log; the same id with another request is refused', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id);
      const request = op({ localDate: TODAY, action: 'set', value: 1 });
      const first = await service.checkIn(user.id, habit.id, request, { now: NOW });
      // Meanwhile the day is changed by another operation.
      await checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value: 0 });
      const retry = await service.checkIn(user.id, habit.id, request, { now: NOW });
      expect(retry.replayed).toBe(true);
      expect(retry.checkIn).toEqual(first.checkIn); // the stored operation, not a new one
      expect(retry.occurrence).toMatchObject({ value: 0, version: 2 }); // the day as it is now
      expect((await eventsOf(habit.id)).length).toBe(2);

      for (const other of [
        { ...request, value: 0 },
        { ...request, localDate: '2026-11-27' },
        { ...request, action: 'skip' as const, value: undefined },
      ]) {
        expect(await codeOf(service.checkIn(user.id, habit.id, other, { now: NOW }))).toBe(
          'IDEMPOTENCY_KEY_REUSED',
        );
      }
      const another = await newHabit(user.id);
      expect(await codeOf(service.checkIn(user.id, another.id, request, { now: NOW }))).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('operation ids are per user', async () => {
      const [a, b] = [await newUser(), await newUser()];
      const [ha, hb] = [await newHabit(a.id), await newHabit(b.id)];
      const request = op({ localDate: TODAY, action: 'set', value: 1 });
      expect((await service.checkIn(a.id, ha.id, request, { now: NOW })).replayed).toBe(false);
      expect((await service.checkIn(b.id, hb.id, request, { now: NOW })).replayed).toBe(false);
    });

    it('ten simultaneous copies of one request apply it exactly once', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id);
      const request = op({ localDate: TODAY, action: 'set', value: 1 });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => service.checkIn(user.id, habit.id, request, { now: NOW })),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.checkIn.id)).size).toBe(1);
      expect(await eventsOf(habit.id)).toHaveLength(1);
      expect(await recordOf(habit.id, TODAY)).toMatchObject({ version: 1 });
    });

    it('the same operation id sent for two habits at once: one wins, the other is refused', async () => {
      const user = await newUser();
      const [h1, h2] = [await newHabit(user.id), await newHabit(user.id)];
      const request = op({ localDate: TODAY, action: 'set', value: 1 });
      const outcomes = await Promise.all(
        [h1, h2].map((h) => codeOf(service.checkIn(user.id, h.id, request, { now: NOW }))),
      );
      expect(outcomes.sort()).toEqual(['IDEMPOTENCY_KEY_REUSED', 'resolved']);
      expect(await db.habitCheckIn.count({ where: { userId: user.id } })).toBe(1);
    });

    it('simultaneous different operations on one day are serialised: no lost update', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id, {
        definition: definition({ type: 'numeric', target: { comparison: 'at_least', value: 5 } }),
      });
      const values = [1, 2, 3, 4, 5, 6, 7, 8];
      await Promise.all(
        values.map((value) =>
          checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value }),
        ),
      );
      const events = await eventsOf(habit.id);
      expect(events).toHaveLength(8);
      // Each write saw the previous one: versions 1..8, no two writes from the same version.
      expect(events.map((e) => e.occurrenceVersion).sort((a, b) => a! - b!)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      const last = events.find((e) => e.occurrenceVersion === 8)!;
      const record = await recordOf(habit.id, TODAY);
      expect(record!.version).toBe(8);
      expect(record!.value!.toNumber()).toBe(last.value!.toNumber()); // the last write wins
    });
  });

  describe('conditional writes (expectedVersion)', () => {
    it('refuses a stale client and accepts a current one; no-ops never conflict', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id);
      const conflict = async (input: Parameters<typeof op>[0]) => {
        try {
          await checkIn(user.id, habit.id, input);
        } catch (error) {
          return error instanceof HabitCheckInError ? [error.code, error.details] : error;
        }
        return 'resolved';
      };
      await checkIn(user.id, habit.id, {
        localDate: TODAY,
        action: 'set',
        value: 1,
        expectedVersion: null,
      });
      expect(
        await conflict({ localDate: TODAY, action: 'set', value: 0, expectedVersion: null }),
      ).toEqual(['VERSION_CONFLICT', { currentVersion: 1 }]);
      await checkIn(user.id, habit.id, {
        localDate: TODAY,
        action: 'set',
        value: 0,
        expectedVersion: 1,
      });
      expect(await conflict({ localDate: TODAY, action: 'skip', expectedVersion: 1 })).toEqual([
        'VERSION_CONFLICT',
        { currentVersion: 2 },
      ]);
      // Asking for what is already stored overwrites nothing: not a conflict.
      expect(
        await conflict({ localDate: TODAY, action: 'set', value: 0, expectedVersion: 1 }),
      ).toBe('resolved');
      expect(await conflict({ localDate: TODAY, action: 'clear', expectedVersion: null })).toEqual([
        'VERSION_CONFLICT',
        { currentVersion: 2 },
      ]);
      await checkIn(user.id, habit.id, { localDate: TODAY, action: 'clear', expectedVersion: 2 });
      // Clearing a record that is already gone is what the client wanted.
      expect(await conflict({ localDate: TODAY, action: 'clear', expectedVersion: 2 })).toBe(
        'resolved',
      );
      expect(
        await conflict({ localDate: TODAY, action: 'set', value: 1, expectedVersion: 2 }),
      ).toEqual(['VERSION_CONFLICT', { currentVersion: null }]);
    });
  });

  describe('which days take a check-in', () => {
    it('no day after today in the profile time zone (the zone decides at the edges)', async () => {
      // 23:59 UTC on the 28th: already the 29th in Tehran, still the 28th in Los Angeles.
      const late = new Date('2026-11-28T23:59:00Z');
      const tehran = await newUser('Asia/Tehran');
      const la = await newUser('America/Los_Angeles');
      const ht = await newHabit(tehran.id);
      const hl = await newHabit(la.id);
      expect(localDateAt(late, 'Asia/Tehran')).toBe('2026-11-29');
      expect(
        (
          await checkIn(
            tehran.id,
            ht.id,
            { localDate: '2026-11-29', action: 'set', value: 1 },
            late,
          )
        ).day.timing,
      ).toBe('today');
      expect(
        await codeOf(
          checkIn(la.id, hl.id, { localDate: '2026-11-29', action: 'set', value: 1 }, late),
        ),
      ).toBe('DATE_IN_FUTURE');
      for (const action of ['skip', 'clear'] as const) {
        expect(
          await codeOf(checkIn(tehran.id, ht.id, { localDate: '2026-11-30', action }, late)),
        ).toBe('DATE_IN_FUTURE');
      }
    });

    it('only inside the habit’s life; skips only on scheduled, not paused days', async () => {
      const user = await newUser();
      // Mondays, Wednesdays, Fridays from 2026-11-02 to 2026-11-27; paused 2026-11-16..18.
      const habit = await newHabit(user.id, {
        startsOn: '2026-11-02',
        endsOn: '2026-11-27',
        definition: definition({ schedule: { kind: 'weekdays', daysOfWeek: [1, 3, 5] } }),
      });
      await db.habitPause.create({
        data: {
          userId: user.id,
          habitId: habit.id,
          startsOn: toDbDate('2026-11-16'),
          endsOn: toDbDate('2026-11-18'),
        },
      });
      const code = (localDate: string, action: 'set' | 'skip' | 'clear') =>
        codeOf(
          checkIn(user.id, habit.id, {
            localDate,
            action,
            ...(action === 'set' ? { value: 1 } : {}),
          }),
        );
      expect(await code('2026-11-01', 'set')).toBe('DATE_NOT_TRACKED'); // before start
      expect(await code('2026-11-28', 'set')).toBe('DATE_NOT_TRACKED'); // after end
      expect(await code('2026-11-28', 'clear')).toBe('resolved'); // clearing is always allowed
      expect(await code('2026-11-03', 'skip')).toBe('SKIP_NOT_ALLOWED'); // Tuesday: off
      expect(await code('2026-11-16', 'skip')).toBe('SKIP_NOT_ALLOWED'); // paused Monday
      expect(await code('2026-11-04', 'skip')).toBe('resolved'); // Wednesday
      // What happened is never refused: values on off and paused days, status unchanged.
      const off = await checkIn(user.id, habit.id, {
        localDate: '2026-11-03',
        action: 'set',
        value: 1,
      });
      expect(off.day).toMatchObject({ status: 'not_scheduled', progress: { met: true } });
      const paused = await checkIn(user.id, habit.id, {
        localDate: '2026-11-16',
        action: 'set',
        value: 1,
      });
      expect(paused.day).toMatchObject({ status: 'paused', pausedState: 'due' });
      // A user-wide vacation pauses it too.
      await db.habitPause.create({
        data: { userId: user.id, startsOn: toDbDate('2026-11-20'), endsOn: toDbDate('2026-11-20') },
      });
      expect(await code('2026-11-20', 'skip')).toBe('SKIP_NOT_ALLOWED');
    });

    it('archived habits are read-only, but a retry of an earlier operation is still answered', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id);
      const request = op({ localDate: TODAY, action: 'set', value: 1 });
      await service.checkIn(user.id, habit.id, request, { now: NOW });
      await db.habit.update({ where: { id: habit.id }, data: { archivedAt: NOW } });
      expect(
        await codeOf(
          checkIn(user.id, habit.id, { localDate: '2026-11-27', action: 'set', value: 1 }),
        ),
      ).toBe('HABIT_ARCHIVED');
      const retry = await service.checkIn(user.id, habit.id, request, { now: NOW });
      expect(retry.replayed).toBe(true);
      // The archive day itself is no longer tracked (ADR-0029).
      expect(retry.day).toMatchObject({ status: 'not_scheduled', inactiveReason: 'archived' });
      const statuses = await service.statuses(
        user.id,
        habit.id,
        { from: '2026-11-26', to: TODAY },
        { now: NOW },
      );
      expect(statuses.days.map((d) => d.status)).toEqual(['missed', 'missed', 'not_scheduled']);
    });

    it('owner scoping: another user’s, a deleted or an unknown habit is not found', async () => {
      const [owner, other] = [await newUser(), await newUser()];
      const habit = await newHabit(owner.id);
      expect(await codeOf(checkIn(other.id, habit.id, { localDate: TODAY, action: 'clear' }))).toBe(
        'NOT_FOUND',
      );
      expect(
        await codeOf(
          service.statuses(other.id, habit.id, { from: TODAY, to: TODAY }, { now: NOW }),
        ),
      ).toBe('NOT_FOUND');
      expect(
        await codeOf(checkIn(owner.id, randomUUID(), { localDate: TODAY, action: 'clear' })),
      ).toBe('NOT_FOUND');
      expect(
        await codeOf(checkIn(owner.id, 'not-a-uuid', { localDate: TODAY, action: 'clear' })),
      ).toBe('NOT_FOUND');
      await db.habit.update({ where: { id: habit.id }, data: { deletedAt: NOW } });
      expect(await codeOf(checkIn(owner.id, habit.id, { localDate: TODAY, action: 'clear' }))).toBe(
        'NOT_FOUND',
      );
      expect(await db.habitCheckIn.count({ where: { habitId: habit.id } })).toBe(0);
    });
  });

  describe('statuses', () => {
    it('grace days keep a past day Due; targets follow the version in effect', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id, {
        definition: definition({
          type: 'numeric',
          target: { comparison: 'at_least', value: 8 },
          graceDays: 1,
        }),
      });
      for (const [localDate, value] of [
        ['2026-11-24', 8],
        ['2026-11-25', 9],
        ['2026-11-26', 3],
      ] as const) {
        await checkIn(user.id, habit.id, { localDate, action: 'set', value });
      }
      await checkIn(user.id, habit.id, { localDate: '2026-11-27', action: 'skip' });
      // From the 25th the target is 10 (a historical correction, audited by P3-03).
      await schedules.changeSchedule(
        user.id,
        habit.id,
        {
          schedule: { kind: 'daily' },
          target: { comparison: 'at_least', value: 10 },
          graceDays: 1,
          effectiveFrom: '2026-11-25',
          reason: 'Target was raised that day',
        },
        { now: NOW },
      );
      const r = await service.statuses(
        user.id,
        habit.id,
        { from: '2026-11-23', to: '2026-11-30' },
        { now: NOW },
      );
      expect(r).toMatchObject({
        habitId: habit.id,
        today: TODAY,
        from: '2026-11-23',
        to: '2026-11-30',
      });
      expect(r.days.map((d) => [d.date, d.status])).toEqual([
        ['2026-11-23', 'missed'], // nothing, closed
        ['2026-11-24', 'completed'], // 8 ≥ 8 (first version)
        ['2026-11-25', 'missed'], // 9 < 10 (corrected version)
        ['2026-11-26', 'missed'],
        ['2026-11-27', 'skipped'],
        ['2026-11-28', 'due'], // today
        ['2026-11-29', 'due'], // future
        ['2026-11-30', 'due'],
      ]);
      const graced = await service.statuses(
        user.id,
        habit.id,
        { from: '2026-11-26', to: '2026-11-26' },
        { now: new Date('2026-11-27T12:00:00+03:30') },
      );
      expect(graced.days[0]).toMatchObject({ status: 'due', openUntil: '2026-11-27' });
    });

    it('frequency habits are judged per week; records outside the range count', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id, {
        definition: definition({
          type: 'frequency',
          schedule: { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
        }),
      });
      // Monday weeks: 2026-11-23..29.
      for (const localDate of ['2026-11-23', '2026-11-24']) {
        await checkIn(user.id, habit.id, { localDate, action: 'set', value: 1 });
      }
      const third = await checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value: 1 });
      expect(third.period).toMatchObject({
        start: '2026-11-23',
        end: '2026-11-29',
        target: 3,
        completed: 3,
        status: 'met',
      });
      const sunday = await service.statuses(
        user.id,
        habit.id,
        { from: '2026-11-29', to: '2026-11-29' },
        { now: NOW },
      );
      expect(sunday.days[0]).toMatchObject({ status: 'not_scheduled', period: 0 });
      expect(sunday.periods[0]).toMatchObject({ completed: 3, status: 'met' });
    });

    it('a check-in and a schedule change of the same habit run one after the other', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id);
      // Both take the habit's row lock, so the check-in is judged by whichever version was in
      // effect when it wrote — never by a half-applied change.
      const [, result] = await Promise.all([
        schedules.changeSchedule(
          user.id,
          habit.id,
          { schedule: { kind: 'weekdays', daysOfWeek: [1] }, target: null, graceDays: 0 },
          { now: NOW },
        ),
        checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value: 1 }),
      ]);
      const { scheduleVersions } = (await repo.findHabit(user.id, habit.id))!;
      expect(scheduleVersions.map((v) => v.id)).toContain(result.day.versionId);
      // Daily (first version) → Completed; Mondays only (today is a Saturday) → Not scheduled.
      const daily = scheduleVersions[0]!.id === result.day.versionId;
      expect(result.day.status).toBe(daily ? 'completed' : 'not_scheduled');
      const now = await service.statuses(
        user.id,
        habit.id,
        { from: TODAY, to: TODAY },
        { now: NOW },
      );
      expect(now.days[0]).toMatchObject({ status: 'not_scheduled', progress: { met: true } });
    });
  });

  describe('integrity in the database', () => {
    it('the log is append-only and refuses values the type does not allow', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id);
      const { checkIn: event } = await checkIn(user.id, habit.id, {
        localDate: TODAY,
        action: 'set',
        value: 1,
      });
      await expect(
        db.$executeRawUnsafe(`UPDATE habit_check_ins SET changed = false WHERE id = '${event.id}'`),
      ).rejects.toThrow(/append-only/);
      const insert = (action: string, value: string, version: string) =>
        db.$executeRawUnsafe(
          `INSERT INTO habit_check_ins (id, user_id, habit_id, habit_type, operation_id, local_date, action, value, changed, occurrence_version, local_today)
           VALUES ('${randomUUID()}', '${user.id}', '${habit.id}', 'binary', '${randomUUID()}', '2026-11-28', '${action}', ${value}, true, ${version}, '2026-11-28')`,
        );
      await expect(insert('set', '2', '1')).rejects.toThrow(/habit_check_ins_value_check/);
      await expect(insert('skip', '1', '1')).rejects.toThrow(/habit_check_ins_value_check/);
      await expect(insert('clear', 'NULL', '1')).rejects.toThrow(
        /habit_check_ins_occurrence_version_check/,
      );
      await expect(insert('set', '1', 'NULL')).rejects.toThrow(
        /habit_check_ins_occurrence_version_check/,
      );
      // Another user's habit cannot be referenced (composite key with user_id).
      const other = await newUser();
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO habit_check_ins (id, user_id, habit_id, habit_type, operation_id, local_date, action, value, changed, occurrence_version, local_today)
           VALUES ('${randomUUID()}', '${other.id}', '${habit.id}', 'binary', '${randomUUID()}', '2026-11-28', 'clear', NULL, false, NULL, '2026-11-28')`,
        ),
      ).rejects.toThrow(/foreign key|habit_check_ins_habit_id_user_id_habit_type_fkey/i);
    });

    it('the export carries each habit’s check-ins; the account purge erases them', async () => {
      const user = await newUser();
      const habit = await newHabit(user.id);
      await checkIn(user.id, habit.id, { localDate: TODAY, action: 'set', value: 1 });
      await checkIn(user.id, habit.id, { localDate: '2026-11-27', action: 'skip' });
      const registry = new UserDataExportRegistry();
      new HabitsDataExportContributor(registry).onModuleInit();
      const file = await new UserDataExportService(
        db as unknown as PrismaService,
        registry,
      ).exportFor(user.id);
      const section = file.sections.habits as { habits: { id: string; checkIns: unknown[] }[] };
      expect(section.habits.find((h) => h.id === habit.id)!.checkIns).toEqual([
        expect.objectContaining({ localDate: TODAY, action: 'set', value: 1, changed: true }),
        expect.objectContaining({ localDate: '2026-11-27', action: 'skip', value: null }),
      ]);
      await db.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
      });
      await new AccountPurgeService(db as unknown as PrismaService).purgeExpired();
      expect(await db.habitCheckIn.count({ where: { userId: user.id } })).toBe(0);
    });
  });
});

describe('habit_check_ins migration on top of the previous release (real PostgreSQL)', () => {
  const name = throwawayDatabaseName();
  const upgradeUrl = withDatabase(databaseUrl, name);
  const migrationsDir = resolve(apiRoot, 'prisma/migrations');
  const MIGRATION = '20261128190000_habit_check_ins';
  let admin: PrismaClient;
  let upgraded: PrismaClient | undefined;
  let workDir: string;

  beforeAll(async () => {
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    workDir = mkdtempSync(join(tmpdir(), 'habit-migrate-p304-'));
  });

  afterAll(async () => {
    await upgraded?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.$disconnect();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('applies over existing habits and records, adds only the new table, leaves no drift', async () => {
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

    upgraded = new PrismaClient({ adapter: new PrismaPg({ connectionString: upgradeUrl }) });
    const id = '0195f0b4-0000-7000-8000-0000000000c1';
    const habitId = '0195f0b5-0000-7000-8000-0000000000c1';
    await upgraded.$executeRawUnsafe(
      `INSERT INTO users (id, email, updated_at) VALUES ('${id}', 'c1@example.test', now())`,
    );
    await upgraded.$executeRawUnsafe(
      `INSERT INTO habits (id, user_id, type, name, starts_on, updated_at)
       VALUES ('${habitId}', '${id}', 'binary', 'Habit', '2026-11-01', now())`,
    );
    await upgraded.$executeRawUnsafe(
      `INSERT INTO habit_occurrences (id, user_id, habit_id, habit_type, local_date, value, updated_at)
       VALUES ('0195f0b6-0000-7000-8000-0000000000c1', '${id}', '${habitId}', 'binary', '2026-11-27', 1, now())`,
    );

    const upgrade = prismaCli(['migrate', 'deploy'], upgradeUrl);
    expect(upgrade.code, upgrade.output).toBe(0);
    const [records] = await upgraded.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM habit_occurrences`,
    );
    expect(Number(records!.n)).toBe(1); // existing records untouched
    const [log] = await upgraded.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM habit_check_ins`,
    );
    expect(Number(log!.n)).toBe(0); // no history invented for existing records
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

describe('check-in routes (whole API on PostgreSQL + Redis)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let repo: HabitRepository;
  const PASSWORD = 'correct horse battery staple';
  const ORIGIN = 'http://localhost:3000';
  let seq = 0;
  let ipSeq = 0;
  const freshIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;
  const http = () => request(app.getHttpServer());

  async function signedUp(label: string) {
    const email = `checkin.http.${label}.${Date.now()}.${++seq}@example.test`;
    await http()
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', freshIp())
      .set('Origin', ORIGIN)
      .send({ email, password: PASSWORD, locale: 'fa', timezone: 'Asia/Tehran' })
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
  const habitFor = async (who: Signed, startsOn: string) =>
    (
      await repo.createHabit(who.id, {
        definition: habitDefinitionSchema.parse({
          type: 'numeric',
          unit: null,
          schedule: { kind: 'daily' },
          target: { comparison: 'at_least', value: 8 },
          graceDays: 0,
        }),
        name: 'Water',
        description: null,
        icon: null,
        color: null,
        categoryId: null,
        startsOn,
        endsOn: null,
        preferredTime: null,
        position: 0,
      })
    ).habit;
  const post = (who: Signed, habitId: string, body: unknown, csrf: string | null = who.csrf) => {
    const req = http()
      .post(`/api/v1/habits/${habitId}/check-ins`)
      .set('Cookie', who.cookie)
      .set('Origin', ORIGIN);
    if (csrf !== null) req.set('X-CSRF-Token', csrf);
    return req.send(body as object);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.RATE_LIMIT_PREFIX = `${keyPrefix}checkins`;
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
    repo = new HabitRepository(db as unknown as PrismaService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    delete process.env.TRUST_PROXY;
  });

  it('requires a session and, for writes, the CSRF token', async () => {
    const who = await signedUp('auth');
    const today = localDateAt(new Date(), 'Asia/Tehran');
    const habit = await habitFor(who, addDays(today, -10));
    const body = { operationId: randomUUID(), localDate: today, action: 'set', value: 3 };
    const anonymous = await http()
      .post(`/api/v1/habits/${habit.id}/check-ins`)
      .set('Origin', ORIGIN)
      .send(body)
      .expect(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');
    await http().get(`/api/v1/habits/${habit.id}/statuses?from=${today}&to=${today}`).expect(401);
    expect((await post(who, habit.id, body, null).expect(403)).body.error.code).toBe('CSRF_FAILED');
    expect(await db.habitCheckIn.count({ where: { habitId: habit.id } })).toBe(0);
  });

  it('records a day, replays a retry and reads statuses', async () => {
    const who = await signedUp('flow');
    const today = localDateAt(new Date(), 'Asia/Tehran');
    const habit = await habitFor(who, addDays(today, -10));
    const body = { operationId: randomUUID(), localDate: today, action: 'set', value: 3 };
    const first = await post(who, habit.id, body).expect(200);
    expect(first.body).toMatchObject({
      replayed: false,
      checkIn: { operationId: body.operationId, action: 'set', value: 3, changed: true },
      occurrence: { localDate: today, value: 3, version: 1 },
      day: { date: today, status: 'due', timing: 'today', progress: { percent: 37 } },
      period: null,
    });
    const retry = await post(who, habit.id, body).expect(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.checkIn).toEqual(first.body.checkIn);

    const from = addDays(today, -1);
    const statuses = await http()
      .get(`/api/v1/habits/${habit.id}/statuses?from=${from}&to=${today}`)
      .set('Cookie', who.cookie)
      .expect(200);
    expect(statuses.body).toMatchObject({ habitId: habit.id, today, from, to: today });
    expect(statuses.body.days.map((d: { status: string }) => d.status)).toEqual(['missed', 'due']);
  });

  it('maps refusals onto the error envelope', async () => {
    const who = await signedUp('errors');
    const today = localDateAt(new Date(), 'Asia/Tehran');
    const habit = await habitFor(who, addDays(today, -10));
    const send = (over: Record<string, unknown>) =>
      post(who, habit.id, {
        operationId: randomUUID(),
        localDate: today,
        action: 'set',
        value: 1,
        ...over,
      });

    const invalid = await send({ action: 'done' }).expect(400);
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED');
    const typed = await post(who, habit.id, {
      operationId: randomUUID(),
      localDate: today,
      action: 'set',
      value: 1.0005,
    }).expect(400);
    expect(typed.body.error.code).toBe('VALIDATION_FAILED');
    expect((await send({ localDate: addDays(today, 2) }).expect(422)).body.error.code).toBe(
      'DATE_IN_FUTURE',
    );
    expect((await send({ localDate: addDays(today, -20) }).expect(422)).body.error.code).toBe(
      'DATE_NOT_TRACKED',
    );
    await send({ expectedVersion: null }).expect(200);
    const conflict = await send({ value: 2, expectedVersion: null }).expect(409);
    expect(conflict.body.error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 1 },
    });
    const operationId = randomUUID();
    await send({ operationId }).expect(200);
    expect((await send({ operationId, value: 5 }).expect(409)).body.error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(
      (
        await http()
          .get(`/api/v1/habits/${habit.id}/statuses?from=2024-01-01&to=2025-01-01`)
          .set('Cookie', who.cookie)
          .expect(400)
      ).body.error.code,
    ).toBe('VALIDATION_FAILED');
  });

  it('another user’s habit answers 404 like a missing one', async () => {
    const [owner, other] = [await signedUp('owner'), await signedUp('other')];
    const today = localDateAt(new Date(), 'Asia/Tehran');
    const habit = await habitFor(owner, addDays(today, -3));
    const body = { operationId: randomUUID(), localDate: today, action: 'clear' };
    expect((await post(other, habit.id, body).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await post(other, randomUUID(), body).expect(404)).body.error.code).toBe('NOT_FOUND');
    await http()
      .get(`/api/v1/habits/${habit.id}/statuses?from=${today}&to=${today}`)
      .set('Cookie', other.cookie)
      .expect(404);
    expect((await post(other, 'nope', body).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
  });
});
