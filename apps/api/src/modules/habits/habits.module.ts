import { Module } from '@nestjs/common';
import { HabitCategoriesController } from './habit-categories.controller.js';
import { HabitCategoryService } from './habit-category.service.js';
import { HabitCheckInController } from './habit-check-in.controller.js';
import { HabitCheckInService } from './habit-check-in.service.js';
import { HabitPurgeHandler, HabitPurgeService } from './habit-purge.js';
import { HabitRepository } from './habit.repository.js';
import { HabitScheduleService } from './habit-schedule.service.js';
import { HabitService } from './habit.service.js';
import { HabitsController } from './habits.controller.js';
import { HabitsDataExportContributor } from './habits-data-export.contributor.js';

/**
 * Habits feature module (backlog P3-01, ADR-0028): owns the habit tables (categories, habits,
 * schedule versions, recorded occurrences, check-ins, notes, pauses) and their data-export
 * section. The schedule engine is P3-02 (pure library, `@habit/habit-engine`), versioning P3-03
 * (`HabitScheduleService`, ADR-0030), check-ins and statuses P3-04 (`HabitCheckInService`,
 * ADR-0031), the habits and categories API P3-06 (`HabitService`, `HabitCategoryService`,
 * ADR-0032); streaks are P3-05.
 */
@Module({
  controllers: [HabitsController, HabitCategoriesController, HabitCheckInController],
  providers: [
    HabitRepository,
    HabitScheduleService,
    HabitCheckInService,
    HabitService,
    HabitCategoryService,
    HabitsDataExportContributor,
  ],
  exports: [HabitRepository, HabitScheduleService, HabitCheckInService, HabitService],
})
export class HabitsModule {}

/**
 * Worker-side part of the habits module: the daily purge of deleted habits (P3-06). Imported by
 * `WorkerModule`, which registers the handler in `JOB_HANDLERS` and `HABIT_SCHEDULES` in
 * `JOB_SCHEDULES`. No controllers.
 */
@Module({
  providers: [HabitPurgeService, HabitPurgeHandler],
  exports: [HabitPurgeHandler],
})
export class HabitsJobsModule {}
