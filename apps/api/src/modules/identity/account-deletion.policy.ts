import { z } from 'zod';
import { ACCOUNT_DELETION_GRACE_DAYS } from '@habit/shared-types';
import { defineJob } from '../../queue/job-definition.js';
import { defineSchedule } from '../../queue/job-schedule.js';

/**
 * Account deletion policy (backlog P2-10, ADR-0025). Interim values, reversible — open decisions
 * for the owner in ADR-0025.
 */
export const ACCOUNT_DELETION_POLICY = {
  /**
   * How long a deleted account stays restorable before the purge erases it. Shared with the web
   * pages and the email through `ACCOUNT_DELETION_GRACE_DAYS`.
   */
  graceMs: ACCOUNT_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
  /** Accounts erased per purge transaction (bounded lock time; the job loops until done). */
  purgeBatchSize: 100,
} as const;

/** When an account deleted at `deletedAt` is erased (unless restored before). */
export function purgeAfter(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + ACCOUNT_DELETION_POLICY.graceMs);
}

/**
 * Worker job that emails the "your account was deleted" confirmation with the restore link. The
 * payload follows the queue payload rule (SECURITY.md): the account id only — the worker reads the
 * address of the (soft-deleted) account and issues the restore token itself.
 */
export const ACCOUNT_DELETED_EMAIL_JOB = defineJob({
  name: 'identity.account-deleted-email',
  queue: 'email',
  schema: z.strictObject({ userId: z.uuid() }),
  options: {
    // Delivery problems are usually transient: 5 tries over ~30 s (2, 4, 8, 16 s).
    attempts: 5,
    backoff: { type: 'exponential' as const, delay: 2_000 },
  },
});

/**
 * Worker job that erases every account whose grace period has passed (hard delete; cascades to
 * all user-owned rows). No payload. Idempotent: running it twice, or concurrently, erases each
 * account once. Runs daily through {@link ACCOUNT_PURGE_SCHEDULE} (ADR-0026); an operator may
 * also enqueue it by hand.
 */
export const ACCOUNT_PURGE_JOB = defineJob({
  name: 'identity.account-purge',
  queue: 'system',
  schema: z.strictObject({}),
  options: { attempts: 3, backoff: { type: 'exponential' as const, delay: 60_000 } },
});

/**
 * Daily purge run (ADR-0026). 23:30 UTC is 03:00 in Tehran (no daylight saving) and the middle of
 * the night in Europe — the quietest hour for most users. An account becomes erasable 30 days
 * after deletion, so it is erased at most a day after its restore window closes (restore checks
 * the deadline itself, so a late purge never extends the window).
 */
export const ACCOUNT_PURGE_SCHEDULE = defineSchedule({
  id: 'identity.account-purge-daily',
  job: ACCOUNT_PURGE_JOB,
  cron: '30 23 * * *',
  payload: {},
  description: 'Erase accounts whose 30-day restore window has passed (ADR-0025).',
});
