import { Module } from '@nestjs/common';
import { HabitRepository } from './habit.repository.js';
import { HabitsDataExportContributor } from './habits-data-export.contributor.js';

/**
 * Habits feature module (backlog P3-01, ADR-0028): owns the habit tables (categories, habits,
 * schedule versions, recorded occurrences, notes, pauses) and their data-export section. No HTTP
 * routes yet — the habits API is P3-06, the schedule engine P3-02 (pure library), versioning
 * P3-03, check-ins and statuses P3-04, streaks P3-05.
 */
@Module({
  providers: [HabitRepository, HabitsDataExportContributor],
  exports: [HabitRepository],
})
export class HabitsModule {}
