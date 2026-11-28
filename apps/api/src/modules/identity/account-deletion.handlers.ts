import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailEnv } from '../../config/env.js';
import { PrismaService } from '../../database/index.js';
import { Mailer } from '../../mail/index.js';
import type { JobPayload } from '../../queue/job-definition.js';
import { ACCOUNT_DELETED_EMAIL_JOB, ACCOUNT_PURGE_JOB } from './account-deletion.policy.js';
import { AccountPurgeService } from './account-purge.service.js';
import { AccountRestoreService } from './account-restore.service.js';
import { accountDeletedMessage, accountRestoreLink, formatPurgeDate } from './identity-emails.js';

/** What a run decided; returned for tests and logged (no personal data). */
export type AccountDeletedEmailOutcome = 'sent' | 'skipped-not-deleted';

/**
 * Worker handler for `identity.account-deleted-email` (backlog P2-10, ADR-0025): issues a restore
 * token valid until the purge (older restore links stop working) and emails the confirmation with
 * the link and the purge date in the account's language, time zone and calendar. An account that
 * is missing or no longer deleted (restored, purged) gets nothing. At-least-once like the other
 * identity emails: a retry issues a new token, superseding the previous one. Never logs the
 * address, token or link.
 *
 * Shaped as the worker's `JobHandler` without importing it (ADR-0016); `WorkerModule` registers it.
 */
@Injectable()
export class AccountDeletedEmailHandler {
  readonly definition = ACCOUNT_DELETED_EMAIL_JOB;
  private readonly logger = new Logger('AccountDeletedEmail');
  private readonly webAppUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly restore: AccountRestoreService,
    private readonly mailer: Mailer,
    config: ConfigService<MailEnv, true>,
  ) {
    this.webAppUrl = config.get('WEB_APP_URL', { infer: true });
  }

  async handle(payload: JobPayload<typeof ACCOUNT_DELETED_EMAIL_JOB>): Promise<void> {
    await this.run(payload);
  }

  async run(
    payload: JobPayload<typeof ACCOUNT_DELETED_EMAIL_JOB>,
    now = new Date(),
  ): Promise<AccountDeletedEmailOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        email: true,
        deletedAt: true,
        preference: { select: { locale: true, timezone: true, calendar: true } },
      },
    });
    let outcome: AccountDeletedEmailOutcome = 'skipped-not-deleted';
    if (user?.deletedAt) {
      const locale = user.preference?.locale ?? 'en';
      const { token, expiresAt } = await this.restore.issue(payload.userId, user.deletedAt, now);
      await this.mailer.send(
        accountDeletedMessage({
          to: user.email,
          locale,
          url: accountRestoreLink(this.webAppUrl, locale, token),
          restoreUntil: formatPurgeDate(
            expiresAt,
            locale,
            user.preference?.timezone ?? 'UTC',
            user.preference?.calendar ?? 'gregorian',
          ),
        }),
        now,
      );
      outcome = 'sent';
    }
    this.logger.log({ msg: 'account deleted email job', outcome });
    return outcome;
  }
}

/**
 * Worker handler for `identity.account-purge` (P2-10, ADR-0025): erases every account whose grace
 * period has passed ({@link AccountPurgeService}).
 */
@Injectable()
export class AccountPurgeHandler {
  readonly definition = ACCOUNT_PURGE_JOB;

  constructor(private readonly purge: AccountPurgeService) {}

  /** The payload is empty (`{}`); nothing to read from it. */
  async handle(): Promise<void> {
    await this.purge.purgeExpired();
  }
}
