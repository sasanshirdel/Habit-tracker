import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UserDataExportRegistry, type UserDataContributor } from '../../data-export/index.js';
import type { DatabaseTransaction } from '../../database/index.js';
import {
  toHabit,
  toHabitCategory,
  toHabitCheckIn,
  toHabitNote,
  toHabitPause,
  toOccurrenceRecord,
  toScheduleChange,
  toScheduleVersion,
} from './habit-mappers.js';

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/**
 * The habits module's section (`habits`) of the user's data export (backlog P3-01, ADR-0025,
 * ADR-0028): every stored habit row of the user — categories, habits (archived and soft-deleted
 * ones too, with `deletedAt`, because they are still stored) with all their schedule versions
 * (each with the week start and calendar it was written with) and their schedule audit trail
 * (P3-03, ADR-0030) and check-in log (P3-04, ADR-0031), recorded occurrences, notes, pauses and
 * vacations. Nothing here is a secret, so every table is included. Computed statuses and streaks are not exported (they are derived, not stored).
 */
@Injectable()
export class HabitsDataExportContributor implements UserDataContributor, OnModuleInit {
  readonly section = 'habits';
  readonly tables = {
    habit_categories: 'included',
    habits: 'included',
    habit_schedule_versions: 'included',
    habit_schedule_changes: 'included',
    habit_occurrences: 'included',
    habit_check_ins: 'included',
    habit_notes: 'included',
    habit_pauses: 'included',
  } as const;

  constructor(private readonly registry: UserDataExportRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async collect(db: DatabaseTransaction, userId: string): Promise<unknown> {
    // Sequential: one transaction is one connection.
    const categories = await db.habitCategory.findMany({
      where: { userId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    const habits = await db.habit.findMany({
      where: { userId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    const versions = await db.habitScheduleVersion.findMany({
      where: { userId },
      orderBy: [{ habitId: 'asc' }, { effectiveFrom: 'asc' }],
    });
    const changes = await db.habitScheduleChange.findMany({
      where: { userId },
      orderBy: [{ habitId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const occurrences = await db.habitOccurrence.findMany({
      where: { userId },
      orderBy: [{ localDate: 'asc' }, { habitId: 'asc' }],
    });
    const checkIns = await db.habitCheckIn.findMany({
      where: { userId },
      orderBy: [{ habitId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const notes = await db.habitNote.findMany({ where: { userId }, orderBy: { id: 'asc' } });
    const pauses = await db.habitPause.findMany({ where: { userId }, orderBy: { id: 'asc' } });

    const versionsByHabit = new Map<string, ReturnType<typeof toScheduleVersion>[]>();
    for (const row of versions) {
      const list = versionsByHabit.get(row.habitId) ?? [];
      list.push(toScheduleVersion(row));
      versionsByHabit.set(row.habitId, list);
    }
    const changesByHabit = new Map<string, ReturnType<typeof toScheduleChange>[]>();
    for (const row of changes) {
      const list = changesByHabit.get(row.habitId) ?? [];
      list.push(toScheduleChange(row));
      changesByHabit.set(row.habitId, list);
    }
    const checkInsByHabit = new Map<string, ReturnType<typeof toHabitCheckIn>[]>();
    for (const row of checkIns) {
      const list = checkInsByHabit.get(row.habitId) ?? [];
      list.push(toHabitCheckIn(row));
      checkInsByHabit.set(row.habitId, list);
    }
    return {
      categories: categories.map(toHabitCategory),
      habits: habits.map((row) => ({
        ...toHabit(row),
        deletedAt: iso(row.deletedAt),
        scheduleVersions: versionsByHabit.get(row.id) ?? [],
        scheduleChanges: changesByHabit.get(row.id) ?? [],
        checkIns: checkInsByHabit.get(row.id) ?? [],
      })),
      occurrences: occurrences.map(toOccurrenceRecord),
      notes: notes.map(toHabitNote),
      pauses: pauses.map(toHabitPause),
    };
  }
}
