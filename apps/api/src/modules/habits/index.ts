/**
 * Public surface of the habits feature module (ADR-0006: other code imports only this file).
 *
 * P3-01 (ADR-0028) delivers the habit tables — categories, habits, schedule versions, recorded
 * occurrences, notes and pauses — owned by this module, the owner-scoped `HabitRepository`, the
 * row ↔ contract mappers and the module's data-export section. Account purge is covered by
 * `ON DELETE CASCADE` from `users` on every table.
 */
export {
  HabitCategoryNotFoundError,
  HabitRepository,
  type HabitWithSchedule,
  type NewHabit,
} from './habit.repository.js';
export {
  fromDbDate,
  scheduleColumns,
  scheduleRuleFromColumns,
  toDbDate,
  toHabit,
  toScheduleVersion,
  versionRuleColumns,
  type ScheduleColumns,
} from './habit-mappers.js';
export { HabitsDataExportContributor } from './habits-data-export.contributor.js';
export { HabitsModule } from './habits.module.js';
