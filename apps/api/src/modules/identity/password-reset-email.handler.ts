import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailEnv } from '../../config/env.js';
import { PrismaService } from '../../database/index.js';
import { Mailer, type EmailLocale } from '../../mail/index.js';
import type { JobPayload } from '../../queue/job-definition.js';
import {
  passwordChangedMessage,
  passwordResetLink,
  passwordResetMessage,
  signInLink,
} from './identity-emails.js';
import { PASSWORD_CHANGED_EMAIL_JOB, PASSWORD_RESET_EMAIL_JOB } from './password-reset.policy.js';
import { PasswordResetService } from './password-reset.service.js';

/** What a run decided; returned for tests and logged (no personal data). */
export type PasswordEmailOutcome = 'sent' | 'skipped-missing';

interface Recipient {
  email: string;
  locale: EmailLocale;
}

/** The account's address and language, or `null` for a missing or deleted account. */
async function recipient(prisma: PrismaService, userId: string): Promise<Recipient | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, deletedAt: true, preference: { select: { locale: true } } },
  });
  if (!user || user.deletedAt !== null) return null;
  // ADR-0017: accounts registered through the API have a language; `en` covers the rest.
  return { email: user.email, locale: user.preference?.locale ?? 'en' };
}

/**
 * Worker handler for `identity.password-reset-email` (backlog P2-05, ADR-0022): issues a fresh
 * reset token (older links stop working) and emails the link in the account's language. Deleted
 * or missing account → nothing. At-least-once like the verification email (ADR-0021): a retry
 * issues a new token, superseding the previous one. Never logs the address, token or link.
 *
 * Shaped as the worker's `JobHandler` without importing it (ADR-0016; see
 * `VerificationEmailHandler`); `WorkerModule` registers it in `JOB_HANDLERS`.
 */
@Injectable()
export class PasswordResetEmailHandler {
  readonly definition = PASSWORD_RESET_EMAIL_JOB;
  private readonly logger = new Logger('PasswordResetEmail');
  private readonly webAppUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: PasswordResetService,
    private readonly mailer: Mailer,
    config: ConfigService<MailEnv, true>,
  ) {
    this.webAppUrl = config.get('WEB_APP_URL', { infer: true });
  }

  async handle(payload: JobPayload<typeof PASSWORD_RESET_EMAIL_JOB>): Promise<void> {
    await this.run(payload);
  }

  async run(
    payload: JobPayload<typeof PASSWORD_RESET_EMAIL_JOB>,
    now = new Date(),
  ): Promise<PasswordEmailOutcome> {
    const to = await recipient(this.prisma, payload.userId);
    let outcome: PasswordEmailOutcome = 'skipped-missing';
    if (to) {
      const { token } = await this.tokens.issue(payload.userId, to.email, now);
      await this.mailer.send(
        passwordResetMessage({
          to: to.email,
          locale: to.locale,
          url: passwordResetLink(this.webAppUrl, to.locale, token),
        }),
        now,
      );
      outcome = 'sent';
    }
    this.logger.log({ msg: 'password reset email job', outcome });
    return outcome;
  }
}

/**
 * Worker handler for `identity.password-changed-email` (P2-05, ADR-0022): tells the account's
 * address that its password was just changed and every device signed out, with a sign-in link
 * and what to do if it was not the owner. No token.
 */
@Injectable()
export class PasswordChangedEmailHandler {
  readonly definition = PASSWORD_CHANGED_EMAIL_JOB;
  private readonly logger = new Logger('PasswordChangedEmail');
  private readonly webAppUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    config: ConfigService<MailEnv, true>,
  ) {
    this.webAppUrl = config.get('WEB_APP_URL', { infer: true });
  }

  async handle(payload: JobPayload<typeof PASSWORD_CHANGED_EMAIL_JOB>): Promise<void> {
    await this.run(payload);
  }

  async run(
    payload: JobPayload<typeof PASSWORD_CHANGED_EMAIL_JOB>,
    now = new Date(),
  ): Promise<PasswordEmailOutcome> {
    const to = await recipient(this.prisma, payload.userId);
    let outcome: PasswordEmailOutcome = 'skipped-missing';
    if (to) {
      await this.mailer.send(
        passwordChangedMessage({
          to: to.email,
          locale: to.locale,
          signInUrl: signInLink(this.webAppUrl, to.locale),
        }),
        now,
      );
      outcome = 'sent';
    }
    this.logger.log({ msg: 'password changed email job', outcome });
    return outcome;
  }
}
