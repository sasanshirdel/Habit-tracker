import type { JobDefinition, JobInput, JobPayload } from './job-definition.js';

/**
 * A recurring job (ADR-0026): which job runs, when, with which payload. Declared next to the job
 * by the module that owns the work (ADR-0006) and registered in the worker's `JOB_SCHEDULES`; the
 * worker turns each one into a BullMQ job scheduler on startup.
 *
 * - **`id`** is the scheduler's stable identity in Redis (`<module>.<action>` like a job name).
 *   Changing a schedule's `cron` keeps its id; renaming the id removes the old scheduler (the
 *   worker deletes schedulers it does not declare) and creates a new one.
 * - **`cron`** is a five-field cron expression (minute hour day-of-month month day-of-week)
 *   evaluated in **UTC** — never the server's or a user's time zone, so the run time does not move
 *   with daylight saving or with the host.
 * - **`payload`** follows the queue payload rule (SECURITY.md): identifiers and small parameters
 *   only. It is validated against the job's schema when the schedule is defined, so a schedule
 *   that could never be handled fails at startup, not at 3 a.m.
 *
 * A scheduled run is an ordinary job of `job`: same queue, schema re-validation, retries
 * (`job.options`), logging and failed-set retention. Handlers must be idempotent — a run can be
 * retried, and after downtime the one missed run executes when the worker is back.
 */
export interface JobScheduleDefinition<D extends JobDefinition = JobDefinition> {
  readonly id: string;
  readonly job: D;
  readonly cron: string;
  readonly payload: JobPayload<D>;
  /** Why the job runs at this time — shown in the ADR/README tables, never used at runtime. */
  readonly description: string;
}

/** Schedules are always evaluated in UTC (see {@link JobScheduleDefinition}). */
export const SCHEDULE_TIME_ZONE = 'UTC';

const SCHEDULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

// Five fields; each is `*`, a number, a range, a list and/or a step (`*/15`, `1-5`, `0,30`).
// Names (`MON`, `JAN`), `?`, `L`, `W`, `#` and a seconds field are deliberately not allowed: the
// subset is enough for maintenance jobs and reads the same in every cron dialect.
const CRON_FIELD = /^(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?(,(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?)*$/;
const CRON_LIMITS: ReadonlyArray<readonly [min: number, max: number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];

/** Whether `cron` is a five-field expression in the supported subset with in-range numbers. */
export function isSupportedCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    if (!CRON_FIELD.test(field)) return false;
    const [min, max] = CRON_LIMITS[index]!;
    return field.split(',').every((part) => {
      const [range, step] = part.split('/');
      if (step !== undefined && Number(step) < 1) return false;
      if (range === '*') return true;
      const [from, to] = range!.split('-').map(Number);
      if (from! < min || from! > max) return false;
      return to === undefined || (to >= from! && to <= max);
    });
  });
}

export function defineSchedule<D extends JobDefinition>(schedule: {
  id: string;
  job: D;
  cron: string;
  payload: JobInput<D>;
  description: string;
}): JobScheduleDefinition<D> {
  if (!SCHEDULE_ID.test(schedule.id)) {
    throw new Error(`Invalid schedule id "${schedule.id}" (expected <module>.<action>)`);
  }
  if (!isSupportedCron(schedule.cron)) {
    throw new Error(`Invalid cron "${schedule.cron}" for schedule "${schedule.id}"`);
  }
  const parsed = schedule.job.schema.safeParse(schedule.payload);
  if (!parsed.success) {
    throw new Error(
      `Schedule "${schedule.id}" has a payload that "${schedule.job.name}" rejects ` +
        `(${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')})`,
    );
  }
  return Object.freeze({
    id: schedule.id,
    job: schedule.job,
    cron: schedule.cron.trim().split(/\s+/).join(' '),
    payload: parsed.data as JobPayload<D>,
    description: schedule.description,
  });
}
