import { PrismaPg } from '@prisma/adapter-pg';
import { habitDefinitionSchema, type HabitDefinitionInput } from '@habit/shared-validation';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { UserDataExportRegistry, UserDataExportService } from '../src/data-export/index.js';
import type { PrismaService } from '../src/database/index.js';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import type { HabitType } from '../src/generated/prisma/enums.js';
import {
  HabitCategoryNotFoundError,
  HabitRepository,
  HabitsDataExportContributor,
  scheduleColumns,
  toDbDate,
  type NewHabit,
} from '../src/modules/habits/index.js';
import { AccountPurgeService } from '../src/modules/identity/index.js';

// Integration (backlog P3-01, ADR-0028): the habit tables on a real PostgreSQL, migrated by
// `prisma migrate deploy` in global setup. Integrity is exercised through the database itself —
// duplicate days, cross-user references, type-specific values, overlapping schedule versions —
// plus the owner-scoped repository, the data export section and the account purge.
const databaseUrl = inject('integrationDatabaseUrl');
const DAY_MS = 24 * 60 * 60 * 1000;

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

describe('habit data model (real PostgreSQL)', () => {
  let db: PrismaClient;
  let repo: HabitRepository;
  let seq = 0;
  const newUser = (deletedAt: Date | null = null) =>
    db.user.create({ data: { email: `habits.${Date.now()}.${++seq}@example.test`, deletedAt } });

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
  /** A habit row written directly (no version), for constraint tests on the habits table. */
  const rawHabit = (
    userId: string,
    type: HabitType = 'binary',
    extra: Partial<Prisma.HabitUncheckedCreateInput> = {},
  ) =>
    db.habit.create({
      data: {
        userId,
        type,
        name: 'Habit',
        startsOn: toDbDate('2026-11-01'),
        unit: type === 'custom' ? 'cups' : null,
        ...extra,
      },
    });
  const version = (
    habit: { id: string; userId: string; type: HabitType },
    data: Partial<Prisma.HabitScheduleVersionUncheckedCreateInput> = {},
  ) =>
    db.habitScheduleVersion.create({
      data: {
        userId: habit.userId,
        habitId: habit.id,
        habitType: habit.type,
        effectiveFrom: toDbDate('2026-11-01'),
        weekStart: 'monday',
        calendar: 'gregorian',
        ...scheduleColumns(
          habit.type === 'frequency'
            ? { kind: 'times_per_period', period: 'week', timesPerPeriod: 3 }
            : { kind: 'daily' },
        ),
        ...data,
      },
    });
  const occurrence = (
    habit: { id: string; userId: string; type: HabitType },
    data: Partial<Prisma.HabitOccurrenceUncheckedCreateInput> = {},
  ) =>
    db.habitOccurrence.create({
      data: {
        userId: habit.userId,
        habitId: habit.id,
        habitType: habit.type,
        localDate: toDbDate('2026-11-28'),
        value: 1,
        ...data,
      },
    });

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    repo = new HabitRepository(db as unknown as PrismaService);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('creates the habit tables with date columns for local days and timestamptz for instants', async () => {
    const rows = await db.$queryRaw<
      { table_name: string; column_name: string; udt_name: string }[]
    >`
      SELECT table_name, column_name, udt_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name LIKE 'habit%'`;
    const tables = new Set(rows.map((r) => r.table_name));
    expect([...tables].sort()).toEqual([
      'habit_categories',
      'habit_notes',
      'habit_occurrences',
      'habit_pauses',
      'habit_schedule_changes',
      'habit_schedule_versions',
      'habits',
    ]);
    for (const r of rows) {
      if (r.column_name.endsWith('_at')) expect(r.udt_name, r.column_name).toBe('timestamptz');
      if (/(_on|_date|_from|effective_to|local_today)$/.test(r.column_name)) {
        expect(r.udt_name, `${r.table_name}.${r.column_name}`).toBe('date');
      }
      if (r.column_name === 'user_id' || r.column_name === 'id') expect(r.udt_name).toBe('uuid');
    }
    const type = (t: string, c: string) =>
      rows.find((r) => r.table_name === t && r.column_name === c)?.udt_name;
    expect(type('habit_occurrences', 'value')).toBe('numeric');
    expect(type('habit_categories', 'name')).toBe('citext');
  });

  describe('HabitRepository', () => {
    it('creates a habit with its first schedule version and reads it back as contracts', async () => {
      const user = await newUser();
      const created = await repo.createHabit(
        user.id,
        newHabit({
          name: 'Drink water',
          definition: definition({
            type: 'numeric',
            unit: 'glasses',
            schedule: { kind: 'weekdays', daysOfWeek: [6, 1, 3] },
            target: { comparison: 'at_least', value: 8 },
          }),
          preferredTime: '07:30',
          startsOn: '2026-03-21',
        }),
      );
      expect(created.habit).toMatchObject({
        type: 'numeric',
        name: 'Drink water',
        unit: 'glasses',
        startsOn: '2026-03-21',
        endsOn: null,
        preferredTime: '07:30',
        version: 1,
        archivedAt: null,
      });
      expect(created.scheduleVersions).toEqual([
        expect.objectContaining({
          effectiveFrom: '2026-03-21',
          effectiveTo: null,
          schedule: { kind: 'weekdays', daysOfWeek: [1, 3, 6] },
          target: { comparison: 'at_least', value: 8 },
          graceDays: 0,
          // No preferences row: the user_preferences defaults are snapshotted (ADR-0030).
          weekStart: 'monday',
          calendar: 'gregorian',
        }),
      ]);
      expect(await repo.findHabit(user.id, created.habit.id)).toEqual(created);
    });

    it('is owner-scoped: another user cannot read, list or attach to a habit or category', async () => {
      const owner = await newUser();
      const other = await newUser();
      const category = await db.habitCategory.create({
        data: { userId: owner.id, name: 'Health' },
      });
      const { habit } = await repo.createHabit(owner.id, newHabit({ categoryId: category.id }));
      expect(habit.categoryId).toBe(category.id);

      expect(await repo.findHabit(other.id, habit.id)).toBeNull();
      expect(await repo.listActiveHabits(other.id)).toEqual([]);
      expect(await repo.listCategories(other.id)).toEqual([]);
      await db.habitOccurrence.create({
        data: {
          userId: owner.id,
          habitId: habit.id,
          habitType: 'binary',
          localDate: toDbDate('2026-11-02'),
          value: 1,
        },
      });
      expect(
        await repo.listOccurrences(other.id, { from: '2026-11-01', to: '2026-11-30' }),
      ).toEqual([]);
      expect(
        await repo.listOccurrences(owner.id, {
          from: '2026-11-01',
          to: '2026-11-30',
          habitId: habit.id,
        }),
      ).toEqual([
        expect.objectContaining({
          habitId: habit.id,
          localDate: '2026-11-02',
          value: 1,
          skipped: false,
        }),
      ]);

      // Another user's category is indistinguishable from a missing one.
      await expect(
        repo.createHabit(other.id, newHabit({ categoryId: category.id })),
      ).rejects.toBeInstanceOf(HabitCategoryNotFoundError);
      expect(await db.habit.count({ where: { userId: other.id } })).toBe(0);
    });

    it('lists active habits in order, leaving out archived and deleted ones', async () => {
      const user = await newUser();
      const b = await repo.createHabit(user.id, newHabit({ name: 'B', position: 2 }));
      const a = await repo.createHabit(user.id, newHabit({ name: 'A', position: 1 }));
      const archived = await repo.createHabit(user.id, newHabit({ name: 'Archived', position: 0 }));
      const deleted = await repo.createHabit(user.id, newHabit({ name: 'Deleted', position: 0 }));
      await db.habit.update({ where: { id: archived.habit.id }, data: { archivedAt: new Date() } });
      await db.habit.update({ where: { id: deleted.habit.id }, data: { deletedAt: new Date() } });
      expect((await repo.listActiveHabits(user.id)).map((h) => h.name)).toEqual(['A', 'B']);
      expect(await repo.findHabit(user.id, archived.habit.id)).not.toBeNull();
      expect(await repo.findHabit(user.id, deleted.habit.id)).toBeNull();
      expect(a.habit.id).not.toBe(b.habit.id);
    });
  });

  describe('occurrences', () => {
    it('at most one per habit and local date (duplicates impossible at the database level)', async () => {
      const user = await newUser();
      const habit = await rawHabit(user.id);
      await version(habit);
      await occurrence(habit);
      await expectRejected(
        occurrence(habit, { value: 0 }),
        /P2002|habit_occurrences_habit_id_local_date_key|23505/,
      );
      // Same day, another habit: fine. Same habit, next day: fine.
      await occurrence(await rawHabit(user.id));
      await occurrence(habit, { localDate: toDbDate('2026-11-29') });
    });

    it('hold either a value or a skip', async () => {
      const user = await newUser();
      const habit = await rawHabit(user.id);
      await occurrence(habit, { value: null, skipped: true });
      await expectRejected(
        occurrence(habit, { localDate: toDbDate('2026-11-27'), value: 1, skipped: true }),
        /habit_occurrences_value_check|23514/,
      );
      await expectRejected(
        occurrence(habit, { localDate: toDbDate('2026-11-26'), value: null }),
        /habit_occurrences_value_check|23514/,
      );
    });

    it.each<[HabitType, string, boolean]>([
      ['binary', '1', true],
      ['binary', '0', true],
      ['binary', '2', false],
      ['frequency', '0.5', false],
      ['duration', '86400', true],
      ['duration', '86401', false],
      ['duration', '60.5', false],
      ['negative', '2', true],
      ['negative', '0.5', false],
      ['numeric', '2.125', true],
      ['custom', '1000000', true],
      ['custom', '1000000.001', false],
      ['numeric', '-1', false],
    ])('%s value %s allowed=%s', async (type, value, allowed) => {
      const user = await newUser();
      const habit = await rawHabit(user.id, type);
      const write = occurrence(habit, { value: new Prisma.Decimal(value) });
      if (allowed) await write;
      else await expectRejected(write, /habit_occurrences_value_check|23514|22003/);
    });

    it('stay inside the supported date window', async () => {
      const user = await newUser();
      const habit = await rawHabit(user.id);
      await expectRejected(
        occurrence(habit, { localDate: toDbDate('1999-12-31') }),
        /habit_occurrences_local_date_check|23514/,
      );
      await expectRejected(
        occurrence(habit, { localDate: toDbDate('2100-01-01') }),
        /habit_occurrences_local_date_check|23514/,
      );
    });
  });

  describe('owner consistency through composite keys', () => {
    it('a row of user B cannot point at a habit of user A', async () => {
      const a = await newUser();
      const b = await newUser();
      const habit = await rawHabit(a.id);
      await expectRejected(
        occurrence({ ...habit, userId: b.id }),
        /P2003|habit_occurrences_habit_id_user_id_habit_type_fkey|23503/,
      );
      await expectRejected(
        version({ ...habit, userId: b.id }),
        /P2003|habit_schedule_versions_habit_id_user_id_habit_type_fkey|23503/,
      );
      await expectRejected(
        db.habitNote.create({ data: { userId: b.id, habitId: habit.id, body: 'x' } }),
        /P2003|habit_notes_habit_id_user_id_fkey|23503/,
      );
      await expectRejected(
        db.habitPause.create({
          data: { userId: b.id, habitId: habit.id, startsOn: toDbDate('2026-12-01') },
        }),
        /P2003|habit_pauses_habit_id_user_id_fkey|23503/,
      );
      const categoryOfA = await db.habitCategory.create({ data: { userId: a.id, name: 'Mind' } });
      await expectRejected(
        rawHabit(b.id, 'binary', { categoryId: categoryOfA.id }),
        /P2003|habits_category_id_user_id_fkey|23503/,
      );
    });

    it('the recorded type must be the habit’s type, and the type cannot change once rows exist', async () => {
      const user = await newUser();
      const habit = await rawHabit(user.id, 'binary');
      await expectRejected(
        occurrence({ ...habit, type: 'numeric' }),
        /P2003|habit_occurrences_habit_id_user_id_habit_type_fkey|23503/,
      );
      await version(habit);
      await expectRejected(
        db.habit.update({ where: { id: habit.id }, data: { type: 'numeric' } }),
        /P2003|habit_schedule_versions_habit_id_user_id_habit_type_fkey|23503/,
      );
    });

    it('a category in use cannot be deleted until its habits are moved (NO ACTION)', async () => {
      const user = await newUser();
      const category = await db.habitCategory.create({
        data: { userId: user.id, name: 'Learning' },
      });
      const habit = await rawHabit(user.id, 'binary', { categoryId: category.id });
      await expectRejected(
        db.habitCategory.delete({ where: { id: category.id } }),
        /P2003|habits_category_id_user_id_fkey|23503/,
      );
      await db.habit.update({ where: { id: habit.id }, data: { categoryId: null } });
      await db.habitCategory.delete({ where: { id: category.id } });
    });

    it('a vacation (pause without a habit) applies to all of a user’s habits', async () => {
      const user = await newUser();
      const vacation = await db.habitPause.create({
        data: { userId: user.id, startsOn: toDbDate('2026-12-20'), endsOn: toDbDate('2026-12-31') },
      });
      expect(vacation.habitId).toBeNull();
      await expectRejected(
        db.habitPause.create({
          data: {
            userId: user.id,
            startsOn: toDbDate('2026-12-20'),
            endsOn: toDbDate('2026-12-19'),
          },
        }),
        /habit_pauses_dates_check|23514/,
      );
    });
  });

  describe('schedule versions', () => {
    it('never overlap for one habit; at most one is open-ended; adjacent ranges are fine', async () => {
      const user = await newUser();
      const habit = await rawHabit(user.id);
      await version(habit, {
        effectiveFrom: toDbDate('2026-01-01'),
        effectiveTo: toDbDate('2026-02-01'),
      });
      await version(habit, {
        effectiveFrom: toDbDate('2026-02-01'),
        effectiveTo: toDbDate('2026-03-01'),
      });
      await version(habit, { effectiveFrom: toDbDate('2026-03-01') });
      await expectRejected(
        version(habit, {
          effectiveFrom: toDbDate('2026-01-15'),
          effectiveTo: toDbDate('2026-01-20'),
        }),
        /habit_schedule_versions_no_overlap|23P01/,
      );
      // A second open version starting later still overlaps the open one.
      await expectRejected(
        version(habit, { effectiveFrom: toDbDate('2027-01-01') }),
        /habit_schedule_versions_no_overlap|23P01/,
      );
      await expectRejected(
        version(habit, {
          effectiveFrom: toDbDate('2025-06-01'),
          effectiveTo: toDbDate('2025-06-01'),
        }),
        /habit_schedule_versions_dates_check|23514/,
      );
      // Another habit's versions are independent.
      await version(await rawHabit(user.id), { effectiveFrom: toDbDate('2026-01-15') });
    });

    const daily = scheduleColumns({ kind: 'daily' });
    it.each<[string, Partial<Prisma.HabitScheduleVersionUncheckedCreateInput>]>([
      ['daily with weekdays', { ...daily, daysOfWeek: [1] }],
      ['weekdays without days', { ...daily, kind: 'weekdays' }],
      ['weekday 8', { ...daily, kind: 'weekdays', daysOfWeek: [8] }],
      ['8 weekdays', { ...daily, kind: 'weekdays', daysOfWeek: [1, 2, 3, 4, 5, 6, 7, 1] }],
      ['monthly day 0', { ...daily, kind: 'monthly_days', daysOfMonth: [0] }],
      ['monthly day 32', { ...daily, kind: 'monthly_days', daysOfMonth: [32] }],
      [
        'interval 1',
        { ...daily, kind: 'interval', intervalDays: 1, anchorDate: toDbDate('2026-01-01') },
      ],
      ['interval without anchor', { ...daily, kind: 'interval', intervalDays: 3 }],
      [
        'monthly with interval',
        { ...daily, kind: 'monthly_days', daysOfMonth: [1], intervalDays: 3 },
      ],
      ['grace 8', { ...daily, graceDays: 8 }],
    ])('rejects a %s rule', async (_label, data) => {
      const user = await newUser();
      const habit = await rawHabit(user.id);
      await expectRejected(
        version(habit, data),
        /habit_schedule_versions_(rule|grace_days)_check|23514/,
      );
    });

    it('accepts every valid rule shape', async () => {
      const user = await newUser();
      const rules = [
        scheduleColumns({ kind: 'weekdays', daysOfWeek: [1, 7] }),
        scheduleColumns({ kind: 'monthly_days', daysOfMonth: [-1, 31] }),
        scheduleColumns({ kind: 'interval', intervalDays: 365, anchorDate: '2026-01-01' }),
      ];
      for (const rule of rules) await version(await rawHabit(user.id), rule);
      const frequency = await rawHabit(user.id, 'frequency');
      await version(
        frequency,
        scheduleColumns({ kind: 'times_per_period', period: 'month', timesPerPeriod: 31 }),
      );
    });

    const target = (comparison: 'at_least' | 'at_most', value: string) => ({
      targetComparison: comparison,
      targetValue: new Prisma.Decimal(value),
    });
    it.each<[HabitType, Partial<Prisma.HabitScheduleVersionUncheckedCreateInput>, boolean]>([
      ['binary', {}, true],
      ['binary', target('at_least', '1'), false],
      ['frequency', {}, true],
      ['frequency', scheduleColumns({ kind: 'daily' }), false],
      [
        'binary',
        scheduleColumns({ kind: 'times_per_period', period: 'week', timesPerPeriod: 2 }),
        false,
      ],
      ['numeric', target('at_least', '8'), true],
      ['numeric', {}, false],
      ['numeric', target('at_most', '8'), false],
      ['numeric', target('at_least', '0'), false],
      ['duration', target('at_least', '1200'), true],
      ['duration', target('at_least', '1200.5'), false],
      ['duration', target('at_least', '86401'), false],
      ['negative', target('at_most', '0'), true],
      ['negative', target('at_least', '1'), false],
      ['custom', target('at_most', '2.5'), true],
      ['custom', target('at_least', '0'), false],
      ['custom', { targetValue: new Prisma.Decimal('1') }, false],
    ])('%s target %o allowed=%s', async (type, data, allowed) => {
      const user = await newUser();
      const habit = await rawHabit(user.id, type);
      const write = version(habit, data);
      if (allowed) await write;
      else await expectRejected(write, /habit_schedule_versions_target_check|23514/);
    });
  });

  describe('habits and categories', () => {
    it.each<[string, Partial<Prisma.HabitUncheckedCreateInput>, HabitType]>([
      ['blank name', { name: ' ' }, 'binary'],
      ['untrimmed name', { name: ' Read' }, 'binary'],
      ['101-character name', { name: 'x'.repeat(101) }, 'binary'],
      ['unit on a binary habit', { unit: 'times' }, 'binary'],
      ['custom without unit', { unit: null }, 'custom'],
      ['raw colour', { color: '#ff0000' }, 'binary'],
      ['ends before it starts', { endsOn: toDbDate('2026-10-31') }, 'binary'],
      ['starts before 2000', { startsOn: toDbDate('1999-12-31') }, 'binary'],
      ['preferred time 24:00', { preferredTimeMinutes: 1440 }, 'binary'],
      ['negative position', { position: -1 }, 'binary'],
      ['version 0', { version: 0 }, 'binary'],
    ])('rejects a habit with %s', async (_label, data, type) => {
      const user = await newUser();
      await expectRejected(rawHabit(user.id, type, data), /habits_\w+_check|23514/);
    });

    it('category names are unique per user, case-insensitively', async () => {
      const user = await newUser();
      await db.habitCategory.create({ data: { userId: user.id, name: 'Health' } });
      await expectRejected(
        db.habitCategory.create({ data: { userId: user.id, name: 'HEALTH' } }),
        /P2002|habit_categories_user_id_name_key|23505/,
      );
      await db.habitCategory.create({ data: { userId: (await newUser()).id, name: 'Health' } });
    });
  });

  describe('data export and account purge', () => {
    async function userWithEverything() {
      const user = await newUser();
      const category = await db.habitCategory.create({
        data: { userId: user.id, name: 'Health', color: 'teal' },
      });
      const { habit } = await repo.createHabit(
        user.id,
        newHabit({
          categoryId: category.id,
          name: 'Meditate',
          definition: definition({
            type: 'duration',
            target: { comparison: 'at_least', value: 600 },
          }),
        }),
      );
      const row = { id: habit.id, userId: user.id, type: 'duration' as const };
      await occurrence(row, { value: 900 });
      await occurrence(row, { localDate: toDbDate('2026-11-27'), value: null, skipped: true });
      await db.habitNote.create({
        data: {
          userId: user.id,
          habitId: habit.id,
          body: 'آرام',
          localDate: toDbDate('2026-11-28'),
        },
      });
      await db.habitPause.create({
        data: { userId: user.id, habitId: habit.id, startsOn: toDbDate('2026-12-01') },
      });
      await db.habitPause.create({ data: { userId: user.id, startsOn: toDbDate('2026-12-20') } });
      await rawHabit(user.id, 'binary', { name: 'Gone', deletedAt: new Date() });
      return { user, habit };
    }

    it('the export has a habits section with every stored habit row of the user only', async () => {
      const { user, habit } = await userWithEverything();
      await userWithEverything(); // someone else's data must not leak in
      const registry = new UserDataExportRegistry();
      new HabitsDataExportContributor(registry).onModuleInit();
      const service = new UserDataExportService(db as unknown as PrismaService, registry);
      const file = await service.exportFor(user.id);
      const section = file.sections.habits as {
        categories: { name: string }[];
        habits: {
          id: string;
          name: string;
          deletedAt: string | null;
          scheduleVersions: unknown[];
          scheduleChanges: unknown[];
        }[];
        occurrences: {
          habitId: string;
          localDate: string;
          value: number | null;
          skipped: boolean;
        }[];
        notes: { body: string }[];
        pauses: { habitId: string | null }[];
      };
      expect(section.categories.map((c) => c.name)).toEqual(['Health']);
      expect(section.habits.map((h) => h.name).sort()).toEqual(['Gone', 'Meditate']);
      expect(section.habits.find((h) => h.name === 'Gone')!.deletedAt).toEqual(expect.any(String));
      expect(section.habits.find((h) => h.id === habit.id)!.scheduleVersions).toEqual([
        expect.objectContaining({
          effectiveFrom: '2026-11-01',
          target: { comparison: 'at_least', value: 600 },
          weekStart: 'monday',
          calendar: 'gregorian',
        }),
      ]);
      expect(section.habits.find((h) => h.id === habit.id)!.scheduleChanges).toEqual([
        expect.objectContaining({ operation: 'create', effectiveFrom: '2026-11-01', before: null }),
      ]);
      expect(section.occurrences).toEqual([
        expect.objectContaining({
          habitId: habit.id,
          localDate: '2026-11-27',
          value: null,
          skipped: true,
        }),
        expect.objectContaining({
          habitId: habit.id,
          localDate: '2026-11-28',
          value: 900,
          skipped: false,
        }),
      ]);
      expect(section.notes.map((n) => n.body)).toEqual(['آرام']);
      expect(section.pauses.map((p) => p.habitId).sort()).toEqual([habit.id, null].sort());
      expect(JSON.parse(JSON.stringify(file))).toEqual(file); // plain JSON
    });

    it('the account purge erases every habit row (cascade from users)', async () => {
      const { user } = await userWithEverything();
      const keep = await userWithEverything();
      await db.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date(Date.now() - 31 * DAY_MS) },
      });
      const purge = new AccountPurgeService(db as unknown as PrismaService);
      expect(await purge.purgeExpired()).toBeGreaterThanOrEqual(1);
      const where = { userId: user.id };
      const counts = await Promise.all([
        db.habitCategory.count({ where }),
        db.habit.count({ where }),
        db.habitScheduleVersion.count({ where }),
        db.habitOccurrence.count({ where }),
        db.habitNote.count({ where }),
        db.habitPause.count({ where }),
        db.habitScheduleChange.count({ where }),
      ]);
      expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(await db.habit.count({ where: { userId: keep.user.id } })).toBe(2);
    });
  });
});
