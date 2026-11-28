import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/index.js';
import { defineJob } from '../../queue/job-definition.js';
import { defineSchedule } from '../../queue/job-schedule.js';
import { HABIT_DELETED_RESTORE_MS } from './habit.service.js';

/**
 * Purge of deleted habits (backlog P3-06, ADR-0032). A deleted habit is restorable for
 * `HABIT_DELETED_RESTORE_DAYS` (30, interim) days; afterwards this daily job hard-deletes it, and
 * the database cascades to its schedule versions, audit trail, recorded days, check-in log, notes
 * and pauses. Restore checks the window itself, so a late purge never extends it. Batched,
 * idempotent and safe to run concurrently; logs counts only.
 */
export const HABIT_PURGE_POLICY = {
  /** Habits deleted per statement (each cascades to its history). */
  batchSize: 200,
} as const;

/** Worker job for the purge. No payload; idempotent. */
export const HABIT_PURGE_JOB = defineJob({
  name: 'habits.deleted-purge',
  queue: 'system',
  schema: z.strictObject({}),
  options: { attempts: 3, backoff: { type: 'exponential' as const, delay: 60_000 } },
});

/** Daily at 23:55 UTC (03:25 Tehran), after the identity jobs — nothing depends on the order. */
export const HABIT_PURGE_SCHEDULE = defineSchedule({
  id: 'habits.deleted-purge-daily',
  job: HABIT_PURGE_JOB,
  cron: '55 23 * * *',
  payload: {},
  description: 'Erase habits deleted more than 30 days ago, with their history (ADR-0032).',
});

/** Every recurring job of the habits module, for the worker's `JOB_SCHEDULES` (ADR-0026). */
export const HABIT_SCHEDULES = [HABIT_PURGE_SCHEDULE] as const;

@Injectable()
export class HabitPurgeService {
  private readonly logger = new Logger('HabitPurge');

  constructor(private readonly prisma: PrismaService) {}

  /** Hard-deletes every habit deleted before `now − 30 days`; returns how many. */
  async purge(now = new Date(), batchSize: number = HABIT_PURGE_POLICY.batchSize): Promise<number> {
    const where = { deletedAt: { lt: new Date(now.getTime() - HABIT_DELETED_RESTORE_MS) } };
    let total = 0;
    for (;;) {
      const ids = await this.prisma.habit.findMany({
        where,
        orderBy: { deletedAt: 'asc' },
        take: batchSize,
        select: { id: true },
      });
      if (ids.length === 0) break;
      // The condition is repeated: a habit undeleted in between is left alone.
      const { count } = await this.prisma.habit.deleteMany({
        where: { id: { in: ids.map((r) => r.id) }, ...where },
      });
      total += count;
      if (ids.length < batchSize) break;
    }
    this.logger.log({ msg: 'deleted habits purged', habits: total });
    return total;
  }
}

/** Worker handler for `habits.deleted-purge` ({@link HabitPurgeService}). */
@Injectable()
export class HabitPurgeHandler {
  readonly definition = HABIT_PURGE_JOB;

  constructor(private readonly purger: HabitPurgeService) {}

  /** The payload is empty (`{}`); nothing to read from it. */
  async handle(): Promise<void> {
    await this.purger.purge();
  }
}
