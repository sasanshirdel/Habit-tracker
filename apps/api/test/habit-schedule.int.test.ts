import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeSchedule, versionIdOn } from '@habit/habit-engine';
import type { HabitScheduleVersion } from '@habit/shared-types';
import {
  habitDefinitionSchema,
  habitScheduleChangeSchema,
  type HabitDefinitionInput,
  type HabitScheduleChangeInput,
} from '@habit/shared-validation';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { PrismaService } from '../src/database/index.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  HabitNotFoundError,
  HabitRepository,
  HabitScheduleChangeError,
  HabitScheduleService,
  toDbDate,
  type NewHabit,
} from '../src/modules/habits/index.js';
import { throwawayDatabaseName, withDatabase } from './integration/database-url.js';
import { prismaCli } from './integration/prisma-cli.js';

// Integration (backlog P3-03, ADR-0030): schedule versioning on a real PostgreSQL — version
// transitions in one transaction, history that never moves, historical corrections with their
// audit trail, the calendar-settings snapshot, concurrency under the row lock and the optimistic
// habit version, and the migration's backfill from the previous release.
const databaseUrl = inject('integrationDatabaseUrl');
const apiRoot = resolve(import.meta.dirname, '..');

/** 08:00 UTC on 2026-11-28 = 11:30 in Tehran: the user's today is 2026-11-28. */
const NOW = new Date('2026-11-28T08:00:00.000Z');

describe('schedule versioning (real PostgreSQL)', () => {
  let db: PrismaClient;
  let repo: HabitRepository;
  let service: HabitScheduleService;
  let seq = 0;

  const newUser = async (
    prefs: {
      weekStart?: 'saturday' | 'sunday' | 'monday';
      calendar?: 'gregorian' | 'solar_hijri';
      timezone?: string;
    } = {},
  ) => {
    const user = await db.user.create({
      data: { email: `schedule.${Date.now()}.${++seq}@example.test` },
    });
    await db.userPreference.create({
      data: {
        userId: user.id,
        locale: 'fa',
        timezone: prefs.timezone ?? 'Asia/Tehran',
        weekStart: prefs.weekStart ?? 'saturday',
        calendar: prefs.calendar ?? 'solar_hijri',
      },
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
  const newHabit = (over: Partial<NewHabit> = {}): NewHabit => ({
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
  });
  const change = (input: HabitScheduleChangeInput) => habitScheduleChangeSchema.parse(input);
  const weekdays = (...days: number[]) =>
    change({ schedule: { kind: 'weekdays', daysOfWeek: days }, target: null, graceDays: 0 });
  const record = (userId: string, habitId: string, localDate: string) =>
    db.habitOccurrence.create({
      data: { userId, habitId, habitType: 'binary', localDate: toDbDate(localDate), value: 1 },
    });
  const versionsOf = async (userId: string, habitId: string) =>
    (await repo.findHabit(userId, habitId))!.scheduleVersions;
  const ranges = (versions: HabitScheduleVersion[]) =>
    versions.map((v) => [v.effectiveFrom, v.effectiveTo]);
  /** The engine's day states for a range (what P3-04 turns into statuses). */
  const states = (versions: HabitScheduleVersion[], from: string, to: string) =>
    computeSchedule({
      startsOn: '2026-11-01',
      endsOn: null,
      versions,
      pauses: [],
      range: { from, to },
    }).days.map((d) => `${d.date}:${d.state}:${d.versionId}`);
  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HabitScheduleChangeError) return error.code;
      if (error instanceof HabitNotFoundError) return 'NOT_FOUND';
      throw error;
    }
    return 'resolved';
  }

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    repo = new HabitRepository(db as unknown as PrismaService);
    service = new HabitScheduleService(db as unknown as PrismaService);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('the first version snapshots the user’s week start and calendar and is audited as create', async () => {
    const user = await newUser();
    // 21:00 UTC on the 28th is already 00:30 on the 29th in Tehran.
    const { habit, scheduleVersions } = await repo.createHabit(
      user.id,
      newHabit({
        definition: { ...definition(), schedule: { kind: 'interval', intervalDays: 3 } },
      }),
      { now: new Date('2026-11-28T21:00:00.000Z') },
    );
    expect(scheduleVersions).toEqual([
      expect.objectContaining({
        effectiveFrom: '2026-11-01',
        weekStart: 'saturday',
        calendar: 'solar_hijri',
        // Interval without an anchor: anchored on the first day (ADR-0030).
        schedule: { kind: 'interval', intervalDays: 3, anchorDate: '2026-11-01' },
      }),
    ]);
    expect(await service.listChanges(user.id, habit.id)).toEqual([
      expect.objectContaining({
        operation: 'create',
        versionId: scheduleVersions[0]!.id,
        effectiveFrom: '2026-11-01',
        localToday: '2026-11-29',
        isCorrection: false,
        before: null,
        after: [expect.objectContaining({ id: scheduleVersions[0]!.id, weekStart: 'saturday' })],
      }),
    ]);
  });

  it('an edit closes the current version yesterday and opens one today; past days never move', async () => {
    const user = await newUser();
    const { habit } = await repo.createHabit(user.id, newHabit());
    await record(user.id, habit.id, '2026-11-20');
    await record(user.id, habit.id, '2026-11-28');
    const before = await versionsOf(user.id, habit.id);
    const pastBefore = states(before, '2026-11-01', '2026-11-27');

    const result = await service.changeSchedule(user.id, habit.id, weekdays(1, 3, 5), { now: NOW });
    expect(result.outcome).toBe('split');
    expect(ranges(result.scheduleVersions)).toEqual([
      ['2026-11-01', '2026-11-28'],
      ['2026-11-28', null],
    ]);
    expect(result.habit.version).toBe(2);
    const [v1, v2] = result.scheduleVersions;
    expect(v1!.id).toBe(before[0]!.id);
    expect(v1!.schedule).toEqual({ kind: 'daily' }); // a past version's rules are never edited
    // Every past day keeps its version and its state: past statuses cannot change.
    expect(states(result.scheduleVersions, '2026-11-01', '2026-11-27')).toEqual(pastBefore);
    expect(versionIdOn(result.scheduleVersions, '2026-11-20')).toBe(v1!.id);
    expect(versionIdOn(result.scheduleVersions, '2026-11-28')).toBe(v2!.id);
    expect(result.change).toMatchObject({
      operation: 'split',
      versionId: v2!.id,
      effectiveFrom: '2026-11-28',
      localToday: '2026-11-28',
      isCorrection: false,
      reason: null,
      affectedRecordedDays: 0,
      before: [expect.objectContaining({ id: v1!.id, effectiveTo: null })],
      after: [
        expect.objectContaining({ id: v1!.id, effectiveTo: '2026-11-28' }),
        expect.objectContaining({ id: v2!.id, effectiveFrom: '2026-11-28' }),
      ],
    });
    expect(await versionsOf(user.id, habit.id)).toEqual(result.scheduleVersions);
  });

  it('a second edit on the same day replaces today’s version; identical rules change nothing', async () => {
    const user = await newUser();
    const { habit } = await repo.createHabit(user.id, newHabit());
    const first = await service.changeSchedule(user.id, habit.id, weekdays(1), { now: NOW });
    const second = await service.changeSchedule(user.id, habit.id, weekdays(2, 4), { now: NOW });
    expect(second.outcome).toBe('replace');
    expect(second.scheduleVersions.map((v) => v.id)).toEqual(
      first.scheduleVersions.map((v) => v.id),
    );
    expect(second.scheduleVersions[1]!.schedule).toEqual({ kind: 'weekdays', daysOfWeek: [2, 4] });
    expect(second.change).toMatchObject({
      operation: 'replace',
      before: [expect.objectContaining({ schedule: { kind: 'weekdays', daysOfWeek: [1] } })],
      after: [expect.objectContaining({ schedule: { kind: 'weekdays', daysOfWeek: [2, 4] } })],
    });
    const same = await service.changeSchedule(user.id, habit.id, weekdays(4, 2), { now: NOW });
    expect(same).toMatchObject({ outcome: 'unchanged', change: null, habit: { version: 3 } });
    expect((await service.listChanges(user.id, habit.id)).map((c) => c.operation)).toEqual([
      'create',
      'split',
      'replace',
    ]);
  });

  it('future-dated edits keep today’s rules until then; an edit before them runs up to them', async () => {
    const user = await newUser();
    const { habit } = await repo.createHabit(user.id, newHabit());
    await service.changeSchedule(
      user.id,
      habit.id,
      change({ ...weekdays(6), effectiveFrom: '2027-01-01' }),
      { now: NOW },
    );
    const result = await service.changeSchedule(
      user.id,
      habit.id,
      change({
        schedule: { kind: 'interval', intervalDays: 2 },
        target: null,
        graceDays: 1,
        effectiveFrom: '2026-12-15',
      }),
      { now: NOW },
    );
    expect(ranges(result.scheduleVersions)).toEqual([
      ['2026-11-01', '2026-12-15'],
      ['2026-12-15', '2027-01-01'],
      ['2027-01-01', null],
    ]);
    expect(result.scheduleVersions[1]!.schedule).toEqual({
      kind: 'interval',
      intervalDays: 2,
      anchorDate: '2026-12-15',
    });
    expect(result.change?.isCorrection).toBe(false);
  });

  it('historical corrections need a reason, re-judge past days and are traceable', async () => {
    const user = await newUser();
    const { habit } = await repo.createHabit(user.id, newHabit());
    for (const day of ['2026-11-05', '2026-11-12', '2026-11-20', '2026-11-28']) {
      await record(user.id, habit.id, day);
    }
    const corrected = change({ ...weekdays(1, 2, 3, 4, 5), effectiveFrom: '2026-11-10' });
    expect(await codeOf(service.changeSchedule(user.id, habit.id, corrected, { now: NOW }))).toBe(
      'REASON_REQUIRED',
    );
    expect(await versionsOf(user.id, habit.id)).toHaveLength(1); // nothing written

    const result = await service.changeSchedule(
      user.id,
      habit.id,
      change({ ...weekdays(1, 2, 3, 4, 5), effectiveFrom: '2026-11-10', reason: 'Weekdays only' }),
      { now: NOW },
    );
    expect(ranges(result.scheduleVersions)).toEqual([
      ['2026-11-01', '2026-11-10'],
      ['2026-11-10', null],
    ]);
    expect(result.change).toMatchObject({
      operation: 'split',
      isCorrection: true,
      reason: 'Weekdays only',
      localToday: '2026-11-28',
      // 11-12 and 11-20 are re-judged; 11-05 stays on the old version, 11-28 is today.
      affectedRecordedDays: 2,
    });
    expect(versionIdOn(result.scheduleVersions, '2026-11-05')).toBe(result.scheduleVersions[0]!.id);
    // A correction of the first version from the habit's start replaces it in place.
    const replace = await service.changeSchedule(
      user.id,
      habit.id,
      change({ ...weekdays(7), effectiveFrom: '2026-11-01', reason: 'Sundays at first' }),
      { now: NOW },
    );
    expect(replace.change).toMatchObject({
      operation: 'replace',
      isCorrection: true,
      affectedRecordedDays: 1,
    });
  });

  it('refuses dates outside the habit, wrong rules for its type, and other users', async () => {
    const user = await newUser();
    const { habit } = await repo.createHabit(user.id, newHabit({ endsOn: '2026-12-31' }));
    const other = await newUser();
    expect(
      await codeOf(
        service.changeSchedule(
          user.id,
          habit.id,
          change({ ...weekdays(1), effectiveFrom: '2026-10-01', reason: 'x' }),
          { now: NOW },
        ),
      ),
    ).toBe('EFFECTIVE_BEFORE_START');
    expect(
      await codeOf(
        service.changeSchedule(
          user.id,
          habit.id,
          change({ ...weekdays(1), effectiveFrom: '2027-01-01' }),
          {
            now: NOW,
          },
        ),
      ),
    ).toBe('EFFECTIVE_AFTER_END');
    expect(
      await codeOf(
        service.changeSchedule(
          user.id,
          habit.id,
          change({
            schedule: { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
            target: null,
            graceDays: 0,
          }),
          { now: NOW },
        ),
      ),
    ).toBe('INVALID_RULES');
    expect(
      await codeOf(service.changeSchedule(other.id, habit.id, weekdays(1), { now: NOW })),
    ).toBe('NOT_FOUND');
    expect(await codeOf(service.listChanges(other.id, habit.id))).toBe('NOT_FOUND');
    expect(await codeOf(service.changeSchedule(user.id, 'not-a-uuid', weekdays(1)))).toBe(
      'NOT_FOUND',
    );
    await db.habit.update({ where: { id: habit.id }, data: { deletedAt: new Date() } });
    expect(await codeOf(service.changeSchedule(user.id, habit.id, weekdays(1), { now: NOW }))).toBe(
      'NOT_FOUND',
    );
    expect(await db.habitScheduleVersion.count({ where: { habitId: habit.id } })).toBe(1);
  });

  it('a preference change affects only versions written afterwards', async () => {
    const user = await newUser({ weekStart: 'saturday', calendar: 'solar_hijri' });
    const { habit } = await repo.createHabit(
      user.id,
      newHabit({
        definition: definition({
          type: 'frequency',
          schedule: { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
        }),
      }),
    );
    await db.userPreference.update({
      where: { userId: user.id },
      data: { weekStart: 'monday', calendar: 'gregorian' },
    });
    const old = await versionsOf(user.id, habit.id);
    expect(old[0]).toMatchObject({ weekStart: 'saturday', calendar: 'solar_hijri' });
    // Same rule, new settings: a new version is written with the new settings.
    const result = await service.changeSchedule(
      user.id,
      habit.id,
      change({
        schedule: { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 },
        target: null,
        graceDays: 0,
      }),
      { now: NOW },
    );
    expect(result.outcome).toBe('split');
    expect(result.scheduleVersions.map((v) => [v.weekStart, v.calendar])).toEqual([
      ['saturday', 'solar_hijri'],
      ['monday', 'gregorian'],
    ]);
  });

  it('uses the profile time zone for "today"', async () => {
    const user = await newUser({ timezone: 'Pacific/Kiritimati' }); // UTC+14
    const { habit } = await repo.createHabit(user.id, newHabit());
    // 2026-11-28T12:00Z is already 2026-11-29 02:00 in Kiritimati.
    const result = await service.changeSchedule(user.id, habit.id, weekdays(1), {
      now: new Date('2026-11-28T12:00:00.000Z'),
    });
    expect(result.change).toMatchObject({ effectiveFrom: '2026-11-29', localToday: '2026-11-29' });
  });

  describe('concurrency', () => {
    it('optimistic: two edits from the same habit version — exactly one wins', async () => {
      const user = await newUser();
      const { habit } = await repo.createHabit(user.id, newHabit());
      const attempts = await Promise.allSettled([
        service.changeSchedule(
          user.id,
          habit.id,
          change({ ...weekdays(1), expectedHabitVersion: 1 }),
          { now: NOW },
        ),
        service.changeSchedule(
          user.id,
          habit.id,
          change({ ...weekdays(2), expectedHabitVersion: 1 }),
          { now: NOW },
        ),
      ]);
      const won = attempts.filter((a) => a.status === 'fulfilled');
      const lost = attempts.filter((a) => a.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const reason = (lost[0] as PromiseRejectedResult).reason as HabitScheduleChangeError;
      expect(reason).toBeInstanceOf(HabitScheduleChangeError);
      expect(reason.code).toBe('VERSION_CONFLICT');
      const versions = await versionsOf(user.id, habit.id);
      expect(versions).toHaveLength(2);
      expect((await repo.findHabit(user.id, habit.id))!.habit.version).toBe(2);
      expect(await db.habitScheduleChange.count({ where: { habitId: habit.id } })).toBe(2);
    });

    it('pessimistic: many simultaneous edits serialise under the row lock into one clean history', async () => {
      const user = await newUser();
      const { habit } = await repo.createHabit(user.id, newHabit());
      const dates = [
        '2026-12-01',
        '2026-12-05',
        '2026-12-09',
        '2026-12-13',
        '2026-12-17',
        '2026-12-21',
      ];
      const results = await Promise.all(
        dates.map((effectiveFrom, i) =>
          service.changeSchedule(
            user.id,
            habit.id,
            change({ ...weekdays((i % 7) + 1), effectiveFrom }),
            { now: NOW },
          ),
        ),
      );
      expect(results.every((r) => r.outcome === 'split')).toBe(true);
      const versions = await versionsOf(user.id, habit.id);
      expect(versions.map((v) => v.effectiveFrom)).toEqual(['2026-11-01', ...dates]);
      // Contiguous and non-overlapping: each version ends where the next begins.
      for (let i = 0; i < versions.length - 1; i++) {
        expect(versions[i]!.effectiveTo).toBe(versions[i + 1]!.effectiveFrom);
      }
      expect(versions.at(-1)!.effectiveTo).toBeNull();
      expect((await repo.findHabit(user.id, habit.id))!.habit.version).toBe(dates.length + 1);
      expect(await db.habitScheduleChange.count({ where: { habitId: habit.id } })).toBe(
        dates.length + 1,
      );
    });

    it('simultaneous edits of the same day: one splits, the rest replace — never two versions', async () => {
      const user = await newUser();
      const { habit } = await repo.createHabit(user.id, newHabit());
      const results = await Promise.all(
        [1, 2, 3, 4].map((day) =>
          service.changeSchedule(user.id, habit.id, weekdays(day), { now: NOW }),
        ),
      );
      expect(results.map((r) => r.outcome).sort()).toEqual([
        'replace',
        'replace',
        'replace',
        'split',
      ]);
      expect(ranges(await versionsOf(user.id, habit.id))).toEqual([
        ['2026-11-01', '2026-11-28'],
        ['2026-11-28', null],
      ]);
    });
  });

  describe('integrity in the database', () => {
    it('audit rows are append-only and go with their habit', async () => {
      const user = await newUser();
      const { habit } = await repo.createHabit(user.id, newHabit());
      await expect(
        db.habitScheduleChange.updateMany({
          where: { habitId: habit.id },
          data: { reason: 'edited' },
        }),
      ).rejects.toThrow(/append-only|23514/);
      await db.habit.delete({ where: { id: habit.id } });
      expect(await db.habitScheduleChange.count({ where: { habitId: habit.id } })).toBe(0);
    });

    it('a correction row without a reason, or a version of another habit, is refused', async () => {
      const user = await newUser();
      const a = await repo.createHabit(user.id, newHabit());
      const b = await repo.createHabit(user.id, newHabit());
      const base = {
        userId: user.id,
        habitId: a.habit.id,
        versionId: a.scheduleVersions[0]!.id,
        operation: 'split' as const,
        effectiveFrom: toDbDate('2026-11-10'),
        localToday: toDbDate('2026-11-28'),
        isCorrection: true,
        before: [],
        after: [],
      };
      await expect(db.habitScheduleChange.create({ data: base })).rejects.toThrow(
        /habit_schedule_changes_correction_check|23514/,
      );
      await expect(
        db.habitScheduleChange.create({ data: { ...base, isCorrection: false, reason: 'x' } }),
      ).rejects.toThrow(/habit_schedule_changes_correction_check|23514/);
      await expect(
        db.habitScheduleChange.create({
          data: { ...base, reason: 'x', versionId: b.scheduleVersions[0]!.id },
        }),
      ).rejects.toThrow(/version_id_habit_id_fkey|Foreign key|P2003/);
    });

    it('pre-existing recorded days outside every version do not block a change', async () => {
      const user = await newUser();
      const { habit } = await repo.createHabit(user.id, newHabit());
      await record(user.id, habit.id, '2026-10-15'); // before the habit's start: no version
      const result = await service.changeSchedule(user.id, habit.id, weekdays(3), { now: NOW });
      expect(result.outcome).toBe('split');
    });
  });
});

describe('schedule_versioning migration backfill (real PostgreSQL)', () => {
  const name = throwawayDatabaseName();
  const upgradeUrl = withDatabase(databaseUrl, name);
  const migrationsDir = resolve(apiRoot, 'prisma/migrations');
  const MIGRATION = '20261128170000_schedule_versioning';
  let admin: PrismaClient;
  let upgraded: PrismaClient | undefined;
  let workDir: string;

  beforeAll(async () => {
    admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    workDir = mkdtempSync(join(tmpdir(), 'habit-migrate-p303-'));
  });

  afterAll(async () => {
    await upgraded?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin?.$disconnect();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('gives existing versions their owner’s week start and calendar (defaults without preferences)', async () => {
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

    // Rows as the previous release (P3-01) wrote them: versions without calendar settings.
    upgraded = new PrismaClient({ adapter: new PrismaPg({ connectionString: upgradeUrl }) });
    const users = [
      ['0195f0b4-0000-7000-8000-0000000000fa', 'fa', 'solar_hijri', 'saturday'],
      ['0195f0b4-0000-7000-8000-0000000000e1', 'en', 'gregorian', 'sunday'],
      ['0195f0b4-0000-7000-8000-000000000000', null, null, null],
    ] as const;
    for (const [i, [id, locale, calendar, weekStart]] of users.entries()) {
      await upgraded.$executeRawUnsafe(
        `INSERT INTO users (id, email, updated_at) VALUES ('${id}', 'u${i}@example.test', now())`,
      );
      if (locale) {
        await upgraded.$executeRawUnsafe(
          `INSERT INTO user_preferences (user_id, locale, timezone, calendar, week_start, updated_at)
           VALUES ('${id}', '${locale}', 'Asia/Tehran', '${calendar}', '${weekStart}', now())`,
        );
      }
      const habitId = id.replace('0195f0b4', '0195f0b5');
      await upgraded.$executeRawUnsafe(
        `INSERT INTO habits (id, user_id, type, name, starts_on, updated_at)
         VALUES ('${habitId}', '${id}', 'binary', 'Habit', '2026-11-01', now())`,
      );
      await upgraded.$executeRawUnsafe(
        `INSERT INTO habit_schedule_versions (id, user_id, habit_id, habit_type, effective_from, effective_to, kind)
         VALUES ('${id.replace('0195f0b4', '0195f0b6')}', '${id}', '${habitId}', 'binary', '2026-11-01', '2026-11-20', 'daily'),
                ('${id.replace('0195f0b4', '0195f0b7')}', '${id}', '${habitId}', 'binary', '2026-11-20', NULL, 'daily')`,
      );
    }

    const upgrade = prismaCli(['migrate', 'deploy'], upgradeUrl);
    expect(upgrade.code, upgrade.output).toBe(0);
    const rows = await upgraded.$queryRawUnsafe<
      { user_id: string; calendar: string; week_start: string; n: bigint }[]
    >(
      `SELECT user_id::text, calendar::text, week_start::text, count(*) AS n
       FROM habit_schedule_versions GROUP BY 1, 2, 3 ORDER BY 1`,
    );
    expect(rows.map((r) => [r.user_id, r.calendar, r.week_start, Number(r.n)])).toEqual([
      ['0195f0b4-0000-7000-8000-000000000000', 'gregorian', 'monday', 2],
      ['0195f0b4-0000-7000-8000-0000000000e1', 'gregorian', 'sunday', 2],
      ['0195f0b4-0000-7000-8000-0000000000fa', 'solar_hijri', 'saturday', 2],
    ]);
    const nullable = await upgraded.$queryRawUnsafe<{ column_name: string; is_nullable: string }[]>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'habit_schedule_versions' AND column_name IN ('calendar', 'week_start')
       ORDER BY column_name`,
    );
    expect(nullable).toEqual([
      { column_name: 'calendar', is_nullable: 'NO' },
      { column_name: 'week_start', is_nullable: 'NO' },
    ]);
    // The upgraded database has no drift from schema.prisma.
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
