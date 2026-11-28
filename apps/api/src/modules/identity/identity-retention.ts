import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/index.js';
import { defineJob } from '../../queue/job-definition.js';
import { defineSchedule } from '../../queue/job-schedule.js';
import { ACCOUNT_PURGE_SCHEDULE } from './account-deletion.policy.js';
import { SECURITY_EVENT_RETENTION_MS } from './security-events.service.js';
import { ENDED_SESSION_RETENTION_MS, endedBefore } from './session.service.js';

/**
 * Global retention clean-up of the identity tables (ADR-0023 follow-up, ADR-0026). The per-account
 * purge on write (ADR-0023) only reaches accounts that are still active; this job deletes the same
 * rows for every account once a day:
 *
 * - security events older than `SECURITY_EVENT_RETENTION_DAYS` (180, interim);
 * - sessions that ended (revoked, expired, idle-expired) more than `ENDED_SESSION_RETENTION_DAYS`
 *   (30, interim) ago — the same predicate as the purge on sign-in;
 * - emailed-link tokens (verification, password reset, account restore) past their expiry. An
 *   expired link is rejected exactly like an unknown one (400 `INVALID_TOKEN`), so deleting it
 *   changes no behaviour; ADR-0017 indexed `expires_at` for this.
 *
 * Batched (bounded lock time per statement; `findMany` on the indexed column, then `deleteMany` by
 * id with the condition repeated, so a row that changed in between is left alone), idempotent and
 * safe to run concurrently. Logs counts only.
 */
export const IDENTITY_RETENTION_POLICY = {
  /** Rows deleted per statement. */
  batchSize: 1_000,
} as const;

/** Worker job for the clean-up. No payload; idempotent. */
export const IDENTITY_RETENTION_JOB = defineJob({
  name: 'identity.retention-cleanup',
  queue: 'system',
  schema: z.strictObject({}),
  options: { attempts: 3, backoff: { type: 'exponential' as const, delay: 60_000 } },
});

/** Daily at 23:45 UTC (03:15 Tehran), after the account purge — nothing depends on the order. */
export const IDENTITY_RETENTION_SCHEDULE = defineSchedule({
  id: 'identity.retention-cleanup-daily',
  job: IDENTITY_RETENTION_JOB,
  cron: '45 23 * * *',
  payload: {},
  description:
    'Delete security events older than 180 days, sessions ended over 30 days ago and expired emailed links (ADR-0023).',
});

export interface RetentionCleanupResult {
  readonly securityEvents: number;
  readonly sessions: number;
  readonly tokens: number;
}

@Injectable()
export class IdentityRetentionService {
  private readonly logger = new Logger('IdentityRetention');

  constructor(private readonly prisma: PrismaService) {}

  async cleanUp(
    now = new Date(),
    batchSize: number = IDENTITY_RETENTION_POLICY.batchSize,
  ): Promise<RetentionCleanupResult> {
    const eventsWhere = {
      createdAt: { lt: new Date(now.getTime() - SECURITY_EVENT_RETENTION_MS) },
    };
    const sessionsWhere = endedBefore(new Date(now.getTime() - ENDED_SESSION_RETENTION_MS));
    const tokensWhere = { expiresAt: { lt: now } };

    const securityEvents = await this.inBatches(batchSize, async (take) => {
      const ids = await this.prisma.userSecurityEvent.findMany({
        where: eventsWhere,
        orderBy: { createdAt: 'asc' },
        take,
        select: { id: true },
      });
      if (ids.length === 0) return [0, 0];
      const { count } = await this.prisma.userSecurityEvent.deleteMany({
        where: { id: { in: ids.map((r) => r.id) }, ...eventsWhere },
      });
      return [ids.length, count];
    });
    const sessions = await this.inBatches(batchSize, async (take) => {
      const ids = await this.prisma.userSession.findMany({
        where: sessionsWhere,
        take,
        select: { id: true },
      });
      if (ids.length === 0) return [0, 0];
      const { count } = await this.prisma.userSession.deleteMany({
        where: { id: { in: ids.map((r) => r.id) }, ...sessionsWhere },
      });
      return [ids.length, count];
    });
    const tokens = await this.inBatches(batchSize, async (take) => {
      const ids = await this.prisma.userToken.findMany({
        where: tokensWhere,
        orderBy: { expiresAt: 'asc' },
        take,
        select: { id: true },
      });
      if (ids.length === 0) return [0, 0];
      const { count } = await this.prisma.userToken.deleteMany({
        where: { id: { in: ids.map((r) => r.id) }, ...tokensWhere },
      });
      return [ids.length, count];
    });

    const result = { securityEvents, sessions, tokens };
    this.logger.log({ msg: 'identity retention clean-up', ...result });
    return result;
  }

  /** Runs `batch` until it finds fewer rows than `batchSize`; returns the rows deleted. */
  private async inBatches(
    batchSize: number,
    batch: (take: number) => Promise<[found: number, deleted: number]>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const [found, deleted] = await batch(batchSize);
      total += deleted;
      if (found < batchSize) return total;
    }
  }
}

/** Worker handler for `identity.retention-cleanup` ({@link IdentityRetentionService}). */
@Injectable()
export class IdentityRetentionHandler {
  readonly definition = IDENTITY_RETENTION_JOB;

  constructor(private readonly retention: IdentityRetentionService) {}

  /** The payload is empty (`{}`); nothing to read from it. */
  async handle(): Promise<void> {
    await this.retention.cleanUp();
  }
}

/** Every recurring job of the identity module, for the worker's `JOB_SCHEDULES` (ADR-0026). */
export const IDENTITY_SCHEDULES = [ACCOUNT_PURGE_SCHEDULE, IDENTITY_RETENTION_SCHEDULE] as const;
