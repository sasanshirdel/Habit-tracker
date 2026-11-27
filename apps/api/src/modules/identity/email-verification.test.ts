import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/index.js';
import { Mailer, MemoryMailTransport } from '../../mail/index.js';
import type { EmailVerificationService } from './email-verification.service.js';
import {
  EMAIL_VERIFICATION_POLICY,
  VERIFICATION_EMAIL_JOB,
  registrationEmailJobId,
} from './email-verification.policy.js';
import {
  ALREADY_REGISTERED_COPY,
  VERIFY_EMAIL_COPY,
  alreadyRegisteredMessage,
  verificationLink,
  verifyEmailMessage,
} from './identity-emails.js';
import { isWellFormedSecretToken, issueSecretToken } from './secret-token.js';
import { VerificationEmailHandler } from './verification-email.handler.js';
import {
  MemoryResendThrottleStore,
  ResendThrottledError,
  VerificationResendThrottle,
} from './verification-resend-throttle.js';

// Backlog P2-04 (ADR-0021): unit tests for the verification email flow. The database and queue
// paths run for real in test/email-verification.int.test.ts.

const USER_ID = '0190d7a0-0000-7000-8000-0000000000aa';

describe('identity email copy', () => {
  it('has identical keys in English and Persian', () => {
    expect(Object.keys(VERIFY_EMAIL_COPY.fa).sort()).toEqual(
      Object.keys(VERIFY_EMAIL_COPY.en).sort(),
    );
    expect(Object.keys(ALREADY_REGISTERED_COPY.fa).sort()).toEqual(
      Object.keys(ALREADY_REGISTERED_COPY.en).sort(),
    );
    for (const copy of [VERIFY_EMAIL_COPY.fa, ALREADY_REGISTERED_COPY.fa]) {
      for (const value of Object.values(copy)) {
        const text = typeof value === 'function' ? value('۲۴') : value;
        // Persian copy is really Persian (not an English fallback).
        expect(text).toMatch(/[\u0600-\u06FF]/);
      }
    }
  });

  it('verification email: link with the token in the fragment, expiry in local digits, RTL for fa', () => {
    const { token } = issueSecretToken();
    const url = verificationLink('https://app.example', 'fa', token);
    expect(url).toBe(`https://app.example/fa/auth/verify-email#token=${token}`);
    const fa = verifyEmailMessage({ to: 'a@example.com', locale: 'fa', url });
    expect(fa).toMatchObject({
      template: 'identity.verify-email',
      locale: 'fa',
      to: 'a@example.com',
    });
    expect(fa.subject).toBe(VERIFY_EMAIL_COPY.fa.subject);
    expect(fa.html).toContain('dir="rtl"');
    expect(fa.html).toContain(`href="${url}"`);
    expect(fa.text).toContain(url);
    expect(fa.text).toContain('۲۴ ساعت');
    const en = verifyEmailMessage({ to: 'a@example.com', locale: 'en', url });
    expect(en.text).toContain('expires in 24 hours');
    expect(en.html).toContain('dir="ltr"');
  });

  it('already-registered notice: links to sign-in, contains no token', () => {
    const message = alreadyRegisteredMessage({
      to: 'a@example.com',
      locale: 'en',
      signInUrl: 'https://app.example/en/auth/sign-in',
    });
    expect(message.template).toBe('identity.already-registered');
    expect(message.text).toContain('https://app.example/en/auth/sign-in');
    expect(message.html).not.toContain('token');
  });
});

describe('verification email job', () => {
  it('carries only the account id and a reason (no address, no token)', () => {
    const schema = VERIFICATION_EMAIL_JOB.schema;
    expect(schema.safeParse({ userId: USER_ID, reason: 'registration' }).success).toBe(true);
    expect(
      schema.safeParse({ userId: USER_ID, reason: 'resend', email: 'a@b.example' }).success,
    ).toBe(false);
    expect(schema.safeParse({ userId: 'not-a-uuid', reason: 'resend' }).success).toBe(false);
    expect(VERIFICATION_EMAIL_JOB.queue).toBe('email');
  });

  it('registration email job id: one per account per window', () => {
    const window = EMAIL_VERIFICATION_POLICY.registrationEmailWindowMs;
    const start = 1_800_000_000_000 - (1_800_000_000_000 % window);
    const a = registrationEmailJobId(USER_ID, start);
    expect(registrationEmailJobId(USER_ID, start + window - 1)).toBe(a);
    expect(registrationEmailJobId(USER_ID, start + window)).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,128}$/); // QueueProducer's job-id rule
  });
});

describe('VerificationEmailHandler', () => {
  function setup(user: unknown) {
    const transport = new MemoryMailTransport();
    const config = {
      get: (key: string) =>
        key === 'WEB_APP_URL' ? 'https://app.example' : 'Habit Tracker <no-reply@app.example>',
    } as unknown as ConfigService<never, true>;
    const mailer = new Mailer(transport, config);
    const { token } = issueSecretToken();
    const tokens = {
      issue: vi.fn(async () => ({ token, expiresAt: new Date() })),
    } as unknown as EmailVerificationService;
    const prisma = {
      user: { findUnique: vi.fn(async () => user) },
    } as unknown as PrismaService;
    const handler = new VerificationEmailHandler(prisma, tokens, mailer, config);
    return { handler, transport, tokens, token };
  }
  const account = (over: Record<string, unknown> = {}) => ({
    email: 'sara@example.com',
    emailVerifiedAt: null,
    deletedAt: null,
    preference: { locale: 'fa' },
    ...over,
  });

  it('unverified account: issues a token and emails the link in the account language', async () => {
    const { handler, transport, tokens, token } = setup(account());
    for (const reason of ['registration', 'resend'] as const) {
      transport.clear();
      expect(await handler.run({ userId: USER_ID, reason })).toBe('sent-verification');
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]).toMatchObject({ to: 'sara@example.com', locale: 'fa' });
      expect(transport.sent[0]!.text).toContain(
        `https://app.example/fa/auth/verify-email#token=${token}`,
      );
    }
    expect(tokens.issue).toHaveBeenCalledWith(USER_ID, 'sara@example.com', expect.any(Date));
    expect(isWellFormedSecretToken(token)).toBe(true);
  });

  it('verified account: the sign-up form sends a notice (no token); a resend sends nothing', async () => {
    const { handler, transport, tokens } = setup(account({ emailVerifiedAt: new Date() }));
    expect(await handler.run({ userId: USER_ID, reason: 'registration' })).toBe(
      'sent-already-registered',
    );
    expect(transport.sent[0]!.template).toBe('identity.already-registered');
    expect(transport.sent[0]!.text).toContain('https://app.example/fa/auth/sign-in');
    expect(await handler.run({ userId: USER_ID, reason: 'resend' })).toBe('skipped-verified');
    expect(transport.sent).toHaveLength(1);
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('deleted or missing account: nothing is sent', async () => {
    for (const user of [null, account({ deletedAt: new Date() })]) {
      const { handler, transport, tokens } = setup(user);
      expect(await handler.run({ userId: USER_ID, reason: 'registration' })).toBe(
        'skipped-missing',
      );
      expect(transport.sent).toHaveLength(0);
      expect(tokens.issue).not.toHaveBeenCalled();
    }
  });

  it('a delivery failure propagates (the job retries)', async () => {
    const { handler, transport } = setup(account());
    transport.failNext = 1;
    await expect(handler.handle({ userId: USER_ID, reason: 'resend' })).rejects.toThrow(
      /simulated/,
    );
  });
});

describe('verification resend throttle', () => {
  it('allows one request per cooldown and at most 5 per hour; a refused request does not count', async () => {
    let now = 0;
    const throttle = new VerificationResendThrottle(new MemoryResendThrottleStore(() => now));
    await throttle.take('u');
    await expect(throttle.take('u')).rejects.toMatchObject({ retryAfterSeconds: 60 });
    await throttle.take('other'); // per account
    for (let i = 0; i < 4; i++) {
      now += 60_000;
      await throttle.take('u');
    }
    now += 60_000; // 5 used within the hour
    const error = await throttle.take('u').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResendThrottledError);
    expect((error as ResendThrottledError).retryAfterSeconds).toBe(3_600 - 300);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { policy: 'verification-email' },
    });
    now = 3_600_000;
    await throttle.take('u');
  });

  it('fails closed with 503 when the store is unavailable', async () => {
    const throttle = new VerificationResendThrottle({
      take: () => Promise.reject(new Error('down')),
    });
    await expect(throttle.take('u')).rejects.toMatchObject({ status: 503 });
  });
});
