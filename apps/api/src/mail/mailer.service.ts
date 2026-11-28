import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailEnv } from '../config/env.js';
import { MAIL_TRANSPORT, type EmailMessage, type MailTransport } from './mail.types.js';

/**
 * Sends transactional email through the configured transport (backlog P2-04, ADR-0021). Runs in
 * the worker (emails are queued jobs); never called on a request path.
 *
 * Logging: one line per message with the template, language, transport and message id — never
 * the recipient, subject, body or links (they carry single-use tokens). A failed delivery logs
 * the error class only and rethrows, so the job retries.
 */
@Injectable()
export class Mailer {
  private readonly logger = new Logger('Mail');
  private readonly from: string;
  private readonly messageIdDomain: string;

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    config: ConfigService<MailEnv, true>,
  ) {
    this.from = config.get('MAIL_FROM', { infer: true });
    this.messageIdDomain = domainOf(this.from);
  }

  get transportName(): string {
    return this.transport.name;
  }

  /** Delivers `message`; returns the generated message id. */
  async send(message: EmailMessage, now = new Date()): Promise<string> {
    if (/[\r\n]/.test(message.to) || /[\r\n]/.test(message.subject)) {
      // Header injection guard; templates and the database never produce these.
      throw new Error('mail: line breaks in recipient or subject');
    }
    const messageId = `${randomUUID()}@${this.messageIdDomain}`;
    try {
      await this.transport.send({ ...message, from: this.from, messageId, date: now });
    } catch (error) {
      this.logger.warn({
        msg: 'email delivery failed',
        template: message.template,
        transport: this.transport.name,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
    this.logger.log({
      msg: 'email sent',
      template: message.template,
      locale: message.locale,
      transport: this.transport.name,
      messageId,
    });
    return messageId;
  }
}

/** The domain part of a `Name <local@domain>` or bare address (for message ids). */
export function domainOf(address: string): string {
  const match = /@([A-Za-z0-9.-]+)>?\s*$/.exec(address);
  return match ? match[1]!.toLowerCase() : 'localhost';
}
