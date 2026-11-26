import { resolve } from 'node:path';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseEnv, MailEnv } from '../config/env.js';
import { MAIL_TRANSPORT, type MailTransport } from './mail.types.js';
import { Mailer } from './mailer.service.js';
import { FileOutboxMailTransport, LogMailTransport } from './transports.js';

/** Builds the transport `MAIL_TRANSPORT` selects (exported for tests). */
export function createMailTransport(
  env: Pick<MailEnv, 'MAIL_TRANSPORT' | 'MAIL_OUTBOX_DIR'> & Pick<BaseEnv, 'NODE_ENV'>,
  logger: Pick<Logger, 'warn'> = new Logger('Mail'),
): MailTransport {
  if (env.MAIL_TRANSPORT === 'outbox') {
    if (!env.MAIL_OUTBOX_DIR) throw new Error('MAIL_OUTBOX_DIR is required for the outbox');
    if (env.NODE_ENV === 'production') {
      // Allowed for the browser suite (which runs production builds); never for real users.
      logger.warn(
        'MAIL_TRANSPORT=outbox with NODE_ENV=production: emails (with live links) are written to ' +
          'a local directory and not delivered. Test environments only.',
      );
    }
    return new FileOutboxMailTransport(resolve(env.MAIL_OUTBOX_DIR));
  }
  return new LogMailTransport();
}

/**
 * Transactional email platform module (backlog P2-04, ADR-0021): the `Mailer` and the configured
 * transport. Imported by modules whose worker-side code sends mail; needs the worker environment
 * (`MAIL_*`, `WEB_APP_URL`). Tests replace `MAIL_TRANSPORT` with a `MemoryMailTransport`.
 */
@Module({
  providers: [
    Mailer,
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<MailEnv & BaseEnv, true>): MailTransport =>
        createMailTransport({
          MAIL_TRANSPORT: config.get('MAIL_TRANSPORT', { infer: true }),
          MAIL_OUTBOX_DIR: config.get('MAIL_OUTBOX_DIR', { infer: true }),
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
        }),
    },
  ],
  exports: [Mailer],
})
export class MailModule {}
