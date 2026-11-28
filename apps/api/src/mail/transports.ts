import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { MailTransport, OutgoingEmail } from './mail.types.js';

/**
 * Development/test transports (backlog P2-04, ADR-0021). None of them contacts a mail server.
 *
 * - {@link LogMailTransport} (default): delivers nothing; logs one line with the template,
 *   language and message id — never the recipient, subject, body or links (they contain
 *   single-use tokens).
 * - {@link FileOutboxMailTransport}: writes each message as a JSON file into a local directory
 *   (`MAIL_OUTBOX_DIR`), so a developer — or the browser suite — can open the link. The files
 *   hold live links and the recipient: local, throwaway directories only.
 * - {@link MemoryMailTransport}: keeps messages in memory for unit/integration tests.
 */

export class LogMailTransport implements MailTransport {
  readonly name = 'log';
  private readonly logger = new Logger('Mail');

  async send(email: OutgoingEmail): Promise<void> {
    this.logger.log({
      msg: 'email not delivered (log transport)',
      template: email.template,
      locale: email.locale,
      messageId: email.messageId,
    });
  }
}

/** Shape of one outbox file (`<outbox>/<time>-<messageId>.json`). */
export interface OutboxFile {
  readonly messageId: string;
  readonly date: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly template: string;
  readonly locale: string;
  readonly text: string;
  readonly html: string;
}

export class FileOutboxMailTransport implements MailTransport {
  readonly name = 'outbox';

  constructor(private readonly directory: string) {}

  async send(email: OutgoingEmail): Promise<void> {
    // Owner-only permissions: the files contain live single-use links.
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file: OutboxFile = {
      messageId: email.messageId,
      date: email.date.toISOString(),
      from: email.from,
      to: email.to,
      subject: email.subject,
      template: email.template,
      locale: email.locale,
      text: email.text,
      html: email.html,
    };
    const stamp = email.date.toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${email.messageId.replace(/[^A-Za-z0-9-]/g, '_')}.json`;
    // `wx`: never overwrite (message ids are unique; a clash is a bug worth failing on).
    await writeFile(join(this.directory, name), `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  }
}

export class MemoryMailTransport implements MailTransport {
  readonly name = 'memory';
  readonly sent: OutgoingEmail[] = [];
  /** Set to make the next sends fail (retry tests). */
  failNext = 0;

  async send(email: OutgoingEmail): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('memory transport: simulated delivery failure');
    }
    this.sent.push(email);
  }

  /** Messages sent to `to` (case-insensitive), oldest first. */
  to(address: string): OutgoingEmail[] {
    const wanted = address.toLowerCase();
    return this.sent.filter((email) => email.to.toLowerCase() === wanted);
  }

  clear(): void {
    this.sent.length = 0;
  }
}
