/**
 * Public surface of the habits feature module (ADR-0006: other code imports only this file).
 *
 * P3-01 (ADR-0028) delivers the habit tables — categories, habits, schedule versions, recorded
 * occurrences, notes and pauses — owned by this module, the owner-scoped `HabitRepository`, the
 * row ↔ contract mappers and the module's data-export section. Account purge is covered by
 * `ON DELETE CASCADE` from `users` on every table.
 *
 * P3-03 (ADR-0030) adds schedule versioning: `HabitScheduleService.changeSchedule` (internal —
 * P3-06 exposes it over HTTP), the pure planning rules and the append-only schedule audit trail.
 *
 * P3-04 (ADR-0031) adds check-ins and statuses: `HabitCheckInService` (idempotent by client
 * operation id, append-only `habit_check_ins` log) and its routes
 * `POST /habits/{habitId}/check-ins`, `GET /habits/{habitId}/statuses`.
 */
export {
  HabitCategoryNotFoundError,
  HabitRepository,
  type HabitWithSchedule,
  type NewHabit,
} from './habit.repository.js';
export {
  HabitCheckInError,
  HabitCheckInService,
  type HabitCheckInErrorCode,
} from './habit-check-in.service.js';
export {
  fromDbDate,
  scheduleColumns,
  scheduleRuleFromColumns,
  toDbDate,
  toHabit,
  toHabitCheckIn,
  toScheduleChange,
  toScheduleVersion,
  versionRuleColumns,
  type ScheduleColumns,
} from './habit-mappers.js';
export {
  HabitNotFoundError,
  HabitScheduleService,
  readScheduleContext,
  type HabitScheduleChangeResult,
  type ScheduleContext,
} from './habit-schedule.service.js';
export {
  HabitScheduleChangeError,
  planScheduleChange,
  type HabitScheduleChangeErrorCode,
  type SchedulePlan,
} from './schedule-versioning.js';
export { HabitsDataExportContributor } from './habits-data-export.contributor.js';
export { HabitsModule } from './habits.module.js';
