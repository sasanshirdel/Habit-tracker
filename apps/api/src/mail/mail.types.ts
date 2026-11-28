/**
 * Transactional email port (backlog P2-04, ADR-0021). Feature modules hand a rendered
 * {@link EmailMessage} to the `Mailer`; a {@link MailTransport} adapter delivers it. Only
 * development/test adapters exist (log, file outbox, in-memory): choosing a real provider is an
 * owner decision (ROADMAP "Outstanding decisions"), and it plugs in here without touching callers.
 */

/** Languages an email can be rendered in (same values as `Locale` in `@habit/localization`). */
export type EmailLocale = 'en' | 'fa';

/** A rendered message, ready to send. */
export interface EmailMessage {
  /** One recipient address (never logged). */
  readonly to: string;
  readonly subject: string;
  /** Plain-text alternative (always present: some clients and screen readers prefer it). */
  readonly text: string;
  /** Complete HTML document; every interpolated value already escaped by the template. */
  readonly html: string;
  readonly locale: EmailLocale;
  /**
   * Stable template name, e.g. `identity.verify-email`. Logged instead of the content, and used by
   * tests and the dev outbox to find messages.
   */
  readonly template: string;
}

/** What a transport receives: the message plus envelope data the `Mailer` adds. */
export interface OutgoingEmail extends EmailMessage {
  readonly from: string;
  /** RFC 5322 `Message-ID` value without angle brackets, unique per send. */
  readonly messageId: string;
  readonly date: Date;
}

/**
 * Delivers one message. Throwing makes the calling job retry (BullMQ backoff); transports must
 * never log or rethrow message content, recipients or links.
 */
export interface MailTransport {
  /** Short name for logs and health, e.g. `log`, `outbox`, `memory`. */
  readonly name: string;
  send(email: OutgoingEmail): Promise<void>;
}

/** Injection token for the configured {@link MailTransport}. */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
