import { z } from 'zod';
import { ACCOUNT_DELETION_GRACE_DAYS } from '@habit/shared-types';
import { defineJob } from '../../queue/job-definition.js';

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
 * account once. Not scheduled automatically yet — the platform has no repeatable-job scheduler
 * (ADR-0025 "Scheduling"); until then it is enqueued by an operator or a deployment's cron.
 */
export const ACCOUNT_PURGE_JOB = defineJob({
  name: 'identity.account-purge',
  queue: 'system',
  schema: z.strictObject({}),
  options: { attempts: 3, backoff: { type: 'exponential' as const, delay: 60_000 } },
});
