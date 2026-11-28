import { Module } from '@nestjs/common';
import { HabitCheckInController } from './habit-check-in.controller.js';
import { HabitCheckInService } from './habit-check-in.service.js';
import { HabitRepository } from './habit.repository.js';
import { HabitScheduleService } from './habit-schedule.service.js';
import { HabitsDataExportContributor } from './habits-data-export.contributor.js';

/**
 * Habits feature module (backlog P3-01, ADR-0028): owns the habit tables (categories, habits,
 * schedule versions, recorded occurrences, check-ins, notes, pauses) and their data-export
 * section. The schedule engine is P3-02 (pure library, `@habit/habit-engine`), versioning P3-03
 * (`HabitScheduleService`, ADR-0030), check-ins and statuses P3-04 (`HabitCheckInService` and the
 * only routes so far, `/habits/{habitId}/check-ins|statuses`, ADR-0031), streaks P3-05, habit
 * CRUD routes P3-06.
 */
@Module({
  controllers: [HabitCheckInController],
  providers: [
    HabitRepository,
    HabitScheduleService,
    HabitCheckInService,
    HabitsDataExportContributor,
  ],
  exports: [HabitRepository, HabitScheduleService, HabitCheckInService],
})
export class HabitsModule {}
