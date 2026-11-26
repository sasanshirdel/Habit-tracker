import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDirection, locales } from '@habit/localization';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonLogger } from '../common/logging/json-logger.js';
import { validateWorkerEnv } from '../config/env.js';
import {
  EMAIL_DIRECTION,
  FileOutboxMailTransport,
  LogMailTransport,
  Mailer,
  MemoryMailTransport,
  assertEmailLinkUrl,
  createMailTransport,
  domainOf,
  escapeHtml,
  renderEmail,
  type EmailContent,
  type OutboxFile,
  type OutgoingEmail,
} from './index.js';

// Backlog P2-04 (ADR-0021): the mail port, its dev/test transports and the shared layout.

const content = (over: Partial<EmailContent> = {}): EmailContent => ({
  locale: 'en',
  subject: 'Hello',
  preheader: 'Pre',
  heading: 'Heading',
  intro: ['Intro'],
  action: { label: 'Go', url: 'https://app.example/en/x#token=abc' },
  outro: ['Outro'],
  footer: 'Footer',
  linkFallback: 'Copy:',
  ...over,
});

const outgoing = (over: Partial<OutgoingEmail> = {}): OutgoingEmail => ({
  to: 'person@example.com',
  subject: 'S',
  text: 'T',
  html: '<p>H</p>',
  locale: 'en',
  template: 'test.template',
  from: 'App <no-reply@app.example>',
  messageId: 'id-1@app.example',
  date: new Date('2026-11-26T10:00:00.000Z'),
  ...over,
});

function captureLogs() {
  const lines: string[] = [];
  const logger = new JsonLogger({
    service: 'worker',
    level: 'trace',
    format: 'json',
    includeErrorMessages: false,
    write: (line) => lines.push(line),
  });
  return { lines, logger };
}

describe('renderEmail', () => {
  it('escapes every string, in text and attributes', () => {
    const evil = `<script>alert("x")</script>&'`;
    const { html, text, subject } = renderEmail(
      content({
        subject: evil,
        heading: evil,
        intro: [evil],
        outro: [evil],
        footer: evil,
        action: { label: evil, url: 'https://app.example/a?b="c"&d=<e>' },
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
    expect(html).toContain('href="https://app.example/a?b=&quot;c&quot;&amp;d=&lt;e&gt;"');
    // Plain text is not HTML: kept verbatim.
    expect(text).toContain(evil);
    expect(subject).toBe(evil);
  });

  it('renders Persian right-to-left and English left-to-right, links always LTR', () => {
    const fa = renderEmail(content({ locale: 'fa', heading: 'سلام' }));
    expect(fa.html).toMatch(/<html lang="fa" dir="rtl">/);
    expect(fa.html).toContain('text-align:right');
    expect(fa.html).toContain('Vazirmatn');
    expect(fa.html).toMatch(/<a href="[^"]+" dir="ltr"/);
    const en = renderEmail(content());
    expect(en.html).toMatch(/<html lang="en" dir="ltr">/);
    expect(en.html).toContain('text-align:left');
  });

  it('matches @habit/localization directions', () => {
    for (const locale of locales) expect(EMAIL_DIRECTION[locale]).toBe(getDirection(locale));
  });

  it('puts the action URL in the plain-text part and collapses line breaks in the subject', () => {
    const { text, subject } = renderEmail(content({ subject: 'a\r\nBcc: x@y' }));
    expect(text).toContain('Go:\nhttps://app.example/en/x#token=abc');
    expect(subject).toBe('a Bcc: x@y');
  });

  it.each([
    ['relative', '/en/auth'],
    ['javascript', 'javascript:alert(1)'],
    ['plain http on a real host', 'http://app.example/x'],
    ['credentials', 'https://user:pw@app.example/x'],
  ])('refuses a %s link', (_name, url) => {
    expect(() => assertEmailLinkUrl(url)).toThrow(/email link/);
    expect(() => renderEmail(content({ action: { label: 'x', url } }))).toThrow(/email link/);
  });

  it('allows https and http on loopback only', () => {
    expect(() => assertEmailLinkUrl('https://app.example/x')).not.toThrow();
    expect(() => assertEmailLinkUrl('http://127.0.0.1:3100/en')).not.toThrow();
    expect(() => assertEmailLinkUrl('http://localhost:3000/en')).not.toThrow();
  });

  it('escapeHtml covers the five special characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('Mailer', () => {
  const config = (from = 'Habit Tracker <no-reply@app.example>') =>
    ({ get: () => from }) as unknown as ConfigService<never, true>;

  it('adds sender, a unique message id and the date; logs no recipient, subject or body', async () => {
    const { lines, logger } = captureLogs();
    const transport = new MemoryMailTransport();
    const mailer = new Mailer(transport, config());
    const { Logger } = await import('@nestjs/common');
    Logger.overrideLogger(logger);
    try {
      const id1 = await mailer.send({
        to: 'secret.person@example.com',
        subject: 'Your link',
        text: 'https://app.example/#token=SECRET',
        html: '<a href="https://app.example/#token=SECRET">x</a>',
        locale: 'fa',
        template: 'identity.verify-email',
      });
      const id2 = await mailer.send({ ...transport.sent[0]!, template: 'identity.verify-email' });
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^[0-9a-f-]{36}@app\.example$/);
      expect(transport.sent[0]).toMatchObject({
        from: 'Habit Tracker <no-reply@app.example>',
        messageId: id1,
        to: 'secret.person@example.com',
      });
      const logged = lines.join('\n');
      expect(logged).toContain('"template":"identity.verify-email"');
      expect(logged).toContain(id1);
      for (const secret of ['secret.person', 'SECRET', 'Your link']) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      Logger.overrideLogger(['error', 'warn', 'log']);
    }
  });

  it('rethrows delivery failures (so the job retries) and refuses header injection', async () => {
    const transport = new MemoryMailTransport();
    transport.failNext = 1;
    const mailer = new Mailer(transport, config());
    const message = {
      to: 'a@example.com',
      subject: 's',
      text: 't',
      html: 'h',
      locale: 'en' as const,
      template: 't.t',
    };
    await expect(mailer.send(message)).rejects.toThrow(/simulated/);
    await expect(
      mailer.send({ ...message, to: 'a@example.com\r\nBcc: b@example.com' }),
    ).rejects.toThrow(/line breaks/);
    await mailer.send(message);
    expect(transport.sent).toHaveLength(1);
  });

  it('derives the message-id domain from the sender', () => {
    expect(domainOf('Name <x@Mail.Example>')).toBe('mail.example');
    expect(domainOf('x@localhost')).toBe('localhost');
  });
});

describe('transports', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('outbox: one owner-only JSON file per message, never overwritten', async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'habit-outbox-')), 'nested');
    const transport = new FileOutboxMailTransport(dir);
    await transport.send(outgoing());
    await transport.send(outgoing({ messageId: 'id-2@app.example' }));
    const files = (await readdir(dir)).sort();
    expect(files).toHaveLength(2);
    const file = JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as OutboxFile;
    expect(file).toMatchObject({
      to: 'person@example.com',
      template: 'test.template',
      locale: 'en',
    });
    expect((await stat(join(dir, files[0]!))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await expect(transport.send(outgoing())).rejects.toThrow(/EEXIST/);
  });

  it('log: delivers nothing and logs only template, locale and message id', async () => {
    const { lines, logger } = captureLogs();
    const { Logger } = await import('@nestjs/common');
    Logger.overrideLogger(logger);
    try {
      await new LogMailTransport().send(outgoing({ text: 'token=SECRET', subject: 'Private' }));
    } finally {
      Logger.overrideLogger(['error', 'warn', 'log']);
    }
    const logged = lines.join('\n');
    expect(logged).toContain('email not delivered (log transport)');
    for (const secret of ['person@example.com', 'SECRET', 'Private']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('createMailTransport: log by default, outbox with a directory, warns in production', () => {
    const warn = vi.fn();
    expect(
      createMailTransport(
        { MAIL_TRANSPORT: 'log', MAIL_OUTBOX_DIR: undefined, NODE_ENV: 'production' },
        { warn },
      ).name,
    ).toBe('log');
    expect(warn).not.toHaveBeenCalled();
    expect(
      createMailTransport(
        { MAIL_TRANSPORT: 'outbox', MAIL_OUTBOX_DIR: '/tmp/x', NODE_ENV: 'development' },
        { warn },
      ).name,
    ).toBe('outbox');
    expect(warn).not.toHaveBeenCalled();
    createMailTransport(
      { MAIL_TRANSPORT: 'outbox', MAIL_OUTBOX_DIR: '/tmp/x', NODE_ENV: 'production' },
      { warn },
    );
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('worker mail environment', () => {
  const required = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
  };

  it('defaults to the log transport, a placeholder sender and the local web app', () => {
    const env = validateWorkerEnv(required);
    expect(env).toMatchObject({
      MAIL_TRANSPORT: 'log',
      MAIL_FROM: 'Habit Tracker <no-reply@localhost>',
      WEB_APP_URL: 'http://localhost:3000',
    });
  });

  it('requires MAIL_OUTBOX_DIR for the outbox', () => {
    expect(() => validateWorkerEnv({ ...required, MAIL_TRANSPORT: 'outbox' })).toThrow(
      /MAIL_OUTBOX_DIR: required when MAIL_TRANSPORT=outbox/,
    );
    expect(
      validateWorkerEnv({ ...required, MAIL_TRANSPORT: 'outbox', MAIL_OUTBOX_DIR: '/tmp/o' }),
    ).toMatchObject({ MAIL_OUTBOX_DIR: '/tmp/o' });
    expect(() => validateWorkerEnv({ ...required, MAIL_TRANSPORT: 'smtp' })).toThrow(
      /MAIL_TRANSPORT/,
    );
  });

  it.each([
    ['http on a real host', 'http://app.example'],
    ['a path', 'https://app.example/app'],
    ['credentials', 'https://u:p@app.example'],
    ['another scheme', 'ftp://app.example'],
  ])('rejects WEB_APP_URL with %s', (_name, value) => {
    expect(() => validateWorkerEnv({ ...required, WEB_APP_URL: value })).toThrow(/WEB_APP_URL/);
  });

  it('normalises WEB_APP_URL to an origin and accepts http on loopback', () => {
    expect(
      validateWorkerEnv({ ...required, WEB_APP_URL: 'https://app.example/' }).WEB_APP_URL,
    ).toBe('https://app.example');
    expect(
      validateWorkerEnv({ ...required, WEB_APP_URL: 'http://127.0.0.1:3100' }).WEB_APP_URL,
    ).toBe('http://127.0.0.1:3100');
  });

  it('rejects a sender with line breaks', () => {
    expect(() =>
      validateWorkerEnv({ ...required, MAIL_FROM: 'A <a@b.example>\r\nBcc: c@d.example' }),
    ).toThrow(/MAIL_FROM/);
    expect(validateWorkerEnv({ ...required, MAIL_FROM: 'no-reply@app.example' }).MAIL_FROM).toBe(
      'no-reply@app.example',
    );
  });
});
