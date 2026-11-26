// Public surface of the transactional email platform area (backlog P2-04, ADR-0021).
export {
  MAIL_TRANSPORT,
  type EmailLocale,
  type EmailMessage,
  type MailTransport,
  type OutgoingEmail,
} from './mail.types.js';
export { Mailer, domainOf } from './mailer.service.js';
export { MailModule, createMailTransport } from './mail.module.js';
export {
  EMAIL_DIRECTION,
  assertEmailLinkUrl,
  escapeHtml,
  renderEmail,
  type EmailAction,
  type EmailContent,
  type RenderedEmail,
} from './render.js';
export {
  FileOutboxMailTransport,
  LogMailTransport,
  MemoryMailTransport,
  type OutboxFile,
} from './transports.js';
