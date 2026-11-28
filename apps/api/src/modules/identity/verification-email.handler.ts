import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailEnv } from '../../config/env.js';
import { PrismaService } from '../../database/index.js';
import { Mailer } from '../../mail/index.js';
import type { JobPayload } from '../../queue/job-definition.js';
import { EmailVerificationService } from './email-verification.service.js';
import { VERIFICATION_EMAIL_JOB } from './email-verification.policy.js';
import {
  alreadyRegisteredMessage,
  signInLink,
  verificationLink,
  verifyEmailMessage,
} from './identity-emails.js';

type Payload = JobPayload<typeof VERIFICATION_EMAIL_JOB>;

/** What a run decided; returned for tests and logged (no personal data). */
export type VerificationEmailOutcome =
  'sent-verification' | 'sent-already-registered' | 'skipped-verified' | 'skipped-missing';

/**
 * Worker handler for `identity.verification-email` (backlog P2-04, ADR-0021). Loads the account,
 * decides what (if anything) to send, issues a fresh token (invalidating older links) and hands
 * the rendered message to the `Mailer`.
 *
 * At-least-once: if delivery fails the job retries with a new token (the previous one is
 * superseded); if the process dies after delivery but before the job completes, the user may get
 * a second email whose link replaces the first. Never logs the address, token or link.
 *
 * Shaped as the worker's `JobHandler` (`definition` + `handle`) without importing it: the worker
 * area composes feature modules, so a module importing the worker would make the areas cyclic
 * (ADR-0016). `WorkerModule` registers it in `JOB_HANDLERS`, where the type is checked.
 */
@Injectable()
export class VerificationEmailHandler {
  readonly definition = VERIFICATION_EMAIL_JOB;
  private readonly logger = new Logger('VerificationEmail');
  private readonly webAppUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: EmailVerificationService,
    private readonly mailer: Mailer,
    config: ConfigService<MailEnv, true>,
  ) {
    this.webAppUrl = config.get('WEB_APP_URL', { infer: true });
  }

  async handle(payload: Payload): Promise<void> {
    await this.run(payload);
  }

  async run(payload: Payload, now = new Date()): Promise<VerificationEmailOutcome> {
    const outcome = await this.decideAndSend(payload, now);
    this.logger.log({ msg: 'verification email job', reason: payload.reason, outcome });
    return outcome;
  }

  private async decideAndSend(payload: Payload, now: Date): Promise<VerificationEmailOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        email: true,
        emailVerifiedAt: true,
        deletedAt: true,
        preference: { select: { locale: true } },
      },
    });
    // Deleted (or gone): nothing to say. A deleted account's address stays reserved (ADR-0017),
    // and the sign-up form answered exactly as for any other address.
    if (!user || user.deletedAt !== null) return 'skipped-missing';
    // ADR-0017: every account registered through the API has a language; `en` covers rows made by
    // other means (e.g. Google sign-in before preferences exist).
    const locale = user.preference?.locale ?? 'en';

    if (user.emailVerifiedAt !== null) {
      if (payload.reason !== 'registration') return 'skipped-verified';
      await this.mailer.send(
        alreadyRegisteredMessage({
          to: user.email,
          locale,
          signInUrl: signInLink(this.webAppUrl, locale),
        }),
        now,
      );
      return 'sent-already-registered';
    }

    const { token } = await this.tokens.issue(payload.userId, user.email, now);
    await this.mailer.send(
      verifyEmailMessage({
        to: user.email,
        locale,
        url: verificationLink(this.webAppUrl, locale, token),
      }),
      now,
    );
    return 'sent-verification';
  }
}
