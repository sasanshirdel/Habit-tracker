import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/index.js';
import { Mailer, MemoryMailTransport } from '../../mail/index.js';
import type { QueueProducer } from '../../queue/queue-producer.service.js';
import {
  PASSWORD_CHANGED_COPY,
  PASSWORD_RESET_COPY,
  passwordChangedMessage,
  passwordResetLink,
  passwordResetMessage,
} from './identity-emails.js';
import { keyFor, type LoginThrottle } from './login-throttle.js';
import type { PasswordHasher } from './password-hasher.js';
import { PasswordRecoveryService } from './password-recovery.service.js';
import {
  PasswordChangedEmailHandler,
  PasswordResetEmailHandler,
} from './password-reset-email.handler.js';
import {
  PASSWORD_CHANGED_EMAIL_JOB,
  PASSWORD_RESET_EMAIL_JOB,
  PASSWORD_RESET_POLICY,
  PASSWORD_RESET_REQUEST_LIMITS,
} from './password-reset.policy.js';
import type { PasswordResetResult, PasswordResetService } from './password-reset.service.js';
import { issueSecretToken } from './secret-token.js';
import {
  MemoryResendThrottleStore,
  VERIFICATION_RESEND_LIMITS,
} from './verification-resend-throttle.js';

// Backlog P2-05 (ADR-0022): unit tests for password recovery. The database, queue and worker
// paths run for real in test/password-reset.int.test.ts.

const USER_ID = '0190d7a0-0000-7000-8000-0000000000bb';

describe('password recovery email copy', () => {
  it('has identical keys in English and Persian, and the Persian copy is Persian', () => {
    expect(Object.keys(PASSWORD_RESET_COPY.fa).sort()).toEqual(
      Object.keys(PASSWORD_RESET_COPY.en).sort(),
    );
    expect(Object.keys(PASSWORD_CHANGED_COPY.fa).sort()).toEqual(
      Object.keys(PASSWORD_CHANGED_COPY.en).sort(),
    );
    for (const copy of [PASSWORD_RESET_COPY.fa, PASSWORD_CHANGED_COPY.fa]) {
      for (const value of Object.values(copy)) {
        const text = typeof value === 'function' ? value('۳۰') : value;
        expect(text).toMatch(/[\u0600-\u06FF]/);
      }
    }
  });

  it('reset email: token in the fragment, lifetime in local digits, RTL for fa', () => {
    const { token } = issueSecretToken();
    const url = passwordResetLink('https://app.example', 'fa', token);
    expect(url).toBe(`https://app.example/fa/auth/reset-password#token=${token}`);
    const fa = passwordResetMessage({ to: 'a@example.com', locale: 'fa', url });
    expect(fa).toMatchObject({ template: 'identity.password-reset', locale: 'fa' });
    expect(fa.subject).toBe(PASSWORD_RESET_COPY.fa.subject);
    expect(fa.html).toContain('dir="rtl"');
    expect(fa.html).toContain(`href="${url}"`);
    expect(fa.text).toContain('۳۰ دقیقه');
    const en = passwordResetMessage({ to: 'a@example.com', locale: 'en', url });
    expect(en.text).toContain('expires in 30 minutes');
    expect(en.html).toContain('dir="ltr"');
  });

  it('"password changed" notice: sign-in link, no token', () => {
    const message = passwordChangedMessage({
      to: 'a@example.com',
      locale: 'en',
      signInUrl: 'https://app.example/en/auth/sign-in',
    });
    expect(message.template).toBe('identity.password-changed');
    expect(message.text).toContain('https://app.example/en/auth/sign-in');
    expect(message.text).toContain('signed out');
    expect(message.html).not.toContain('token');
  });
});

describe('password recovery jobs and policy', () => {
  it('payloads carry only the account id (no address, no token)', () => {
    for (const job of [PASSWORD_RESET_EMAIL_JOB, PASSWORD_CHANGED_EMAIL_JOB]) {
      expect(job.queue).toBe('email');
      expect(job.schema.safeParse({ userId: USER_ID }).success).toBe(true);
      expect(job.schema.safeParse({ userId: USER_ID, email: 'a@b.example' }).success).toBe(false);
      expect(job.schema.safeParse({ userId: 'nope' }).success).toBe(false);
    }
  });

  it('links live 30 minutes; requests are limited to 1/min and 5/h per address', () => {
    expect(PASSWORD_RESET_POLICY.tokenLifetimeMs).toBe(30 * 60_000);
    expect(PASSWORD_RESET_REQUEST_LIMITS).toEqual({
      policy: 'password-reset',
      cooldownMs: 60_000,
      maxPerHour: 5,
    });
  });

  it('the email-send store keeps policies apart', async () => {
    const store = new MemoryResendThrottleStore(() => 0);
    expect(await store.take('k', PASSWORD_RESET_REQUEST_LIMITS)).toBe(0);
    expect(await store.take('k', VERIFICATION_RESEND_LIMITS)).toBe(0);
    expect(await store.take('k', PASSWORD_RESET_REQUEST_LIMITS)).toBe(60_000);
  });
});

function mailSetup() {
  const transport = new MemoryMailTransport();
  const config = {
    get: (key: string) =>
      key === 'WEB_APP_URL' ? 'https://app.example' : 'Habit Tracker <no-reply@app.example>',
  } as unknown as ConfigService<never, true>;
  return { transport, config, mailer: new Mailer(transport, config) };
}
const account = (over: Record<string, unknown> = {}) => ({
  email: 'sara@example.com',
  deletedAt: null,
  preference: { locale: 'fa' },
  ...over,
});
const prismaWith = (user: unknown) =>
  ({ user: { findUnique: vi.fn(async () => user) } }) as unknown as PrismaService;

describe('PasswordResetEmailHandler', () => {
  function setup(user: unknown) {
    const { transport, config, mailer } = mailSetup();
    const { token } = issueSecretToken();
    const tokens = {
      issue: vi.fn(async () => ({ token, expiresAt: new Date() })),
    } as unknown as PasswordResetService;
    const handler = new PasswordResetEmailHandler(prismaWith(user), tokens, mailer, config);
    return { handler, transport, tokens, token };
  }

  it('issues a token and emails the link in the account language', async () => {
    const { handler, transport, tokens, token } = setup(account());
    expect(await handler.run({ userId: USER_ID })).toBe('sent');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      to: 'sara@example.com',
      locale: 'fa',
      template: 'identity.password-reset',
    });
    expect(transport.sent[0]!.text).toContain(
      `https://app.example/fa/auth/reset-password#token=${token}`,
    );
    expect(tokens.issue).toHaveBeenCalledWith(USER_ID, 'sara@example.com', expect.any(Date));
  });

  it('deleted or missing account: no token, no email', async () => {
    for (const user of [null, account({ deletedAt: new Date() })]) {
      const { handler, transport, tokens } = setup(user);
      expect(await handler.run({ userId: USER_ID })).toBe('skipped-missing');
      expect(transport.sent).toHaveLength(0);
      expect(tokens.issue).not.toHaveBeenCalled();
    }
  });

  it('a delivery failure propagates (the job retries)', async () => {
    const { handler, transport } = setup(account());
    transport.failNext = 1;
    await expect(handler.handle({ userId: USER_ID })).rejects.toThrow(/simulated/);
  });
});

describe('PasswordChangedEmailHandler', () => {
  it('emails the notice in the account language; nothing for a deleted account', async () => {
    const { transport, config, mailer } = mailSetup();
    const handler = new PasswordChangedEmailHandler(
      prismaWith(account({ preference: { locale: 'en' } })),
      mailer,
      config,
    );
    expect(await handler.run({ userId: USER_ID })).toBe('sent');
    expect(transport.sent[0]).toMatchObject({
      template: 'identity.password-changed',
      locale: 'en',
    });
    expect(transport.sent[0]!.text).toContain('https://app.example/en/auth/sign-in');

    const gone = new PasswordChangedEmailHandler(
      prismaWith(account({ deletedAt: new Date() })),
      mailer,
      config,
    );
    expect(await gone.run({ userId: USER_ID })).toBe('skipped-missing');
    expect(transport.sent).toHaveLength(1);
  });
});

describe('PasswordRecoveryService', () => {
  function setup(
    opts: {
      user?: { id: string } | null;
      store?: { take: (key: string) => Promise<number> };
      usable?: boolean;
      result?: PasswordResetResult;
    } = {},
  ) {
    let now = 0;
    const store = opts.store ?? new MemoryResendThrottleStore(() => now);
    const prisma = {
      user: {
        findFirst: vi.fn(async () => (opts.user === undefined ? { id: USER_ID } : opts.user)),
      },
    } as unknown as PrismaService;
    const hasher = { hash: vi.fn(async () => '$argon2id$v=19$stub') } as unknown as PasswordHasher;
    const tokens = {
      isUsable: vi.fn(async () => opts.usable ?? true),
      reset: vi.fn(
        async () =>
          opts.result ?? {
            kind: 'reset' as const,
            userId: USER_ID,
            email: 'sara@example.com',
            tokenId: '0190d7a0-0000-7000-8000-0000000000cc',
            sessionsRevoked: 2,
          },
      ),
    } as unknown as PasswordResetService;
    const queue = { enqueue: vi.fn(async () => ({ id: 'j', name: 'n', queue: 'email' })) };
    const loginThrottle = { recordSuccess: vi.fn(async () => undefined) };
    const service = new PasswordRecoveryService(
      prisma,
      hasher,
      tokens,
      queue as unknown as QueueProducer,
      loginThrottle as unknown as LoginThrottle,
      store as MemoryResendThrottleStore,
    );
    return {
      service,
      prisma,
      hasher,
      tokens,
      queue,
      loginThrottle,
      advance: (ms: number) => (now += ms),
    };
  }

  it('request: queues the reset email with the account id only; then limits the address', async () => {
    const { service, queue, advance } = setup();
    expect(await service.requestReset('sara@example.com')).toBe('queued');
    expect(queue.enqueue).toHaveBeenCalledWith(PASSWORD_RESET_EMAIL_JOB, { userId: USER_ID });
    expect(await service.requestReset('sara@example.com')).toBe('throttled');
    advance(60_000);
    expect(await service.requestReset('sara@example.com')).toBe('queued');
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });

  it('request: unknown (or deleted) address → nothing queued, but the limit still counts', async () => {
    const { service, queue, prisma } = setup({ user: null });
    expect(await service.requestReset('nobody@example.com')).toBe('no-account');
    expect(await service.requestReset('nobody@example.com')).toBe('throttled');
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'nobody@example.com', deletedAt: null } }),
    );
  });

  it('request: limiter keyed by a hash of the address, never the address', async () => {
    const take = vi.fn(async () => 0);
    const { service } = setup({ store: { take } });
    await service.requestReset('sara@example.com');
    expect(take).toHaveBeenCalledWith(keyFor('sara@example.com'), PASSWORD_RESET_REQUEST_LIMITS);
  });

  it('request: fails closed (no email) when the limiter is unavailable; never throws', async () => {
    const { service, queue } = setup({ store: { take: () => Promise.reject(new Error('down')) } });
    expect(await service.requestReset('sara@example.com')).toBe('failed');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('request: a queue outage is swallowed (the client already got its 202)', async () => {
    const { service, queue } = setup();
    queue.enqueue.mockRejectedValueOnce(new Error('queue down'));
    expect(await service.requestReset('sara@example.com')).toBe('failed');
    await service.settled();
  });

  it('reset: hashes only for a usable link; dead link → invalid', async () => {
    const { service, hasher, tokens } = setup({ usable: false });
    expect(await service.resetPassword('t', 'new password 1')).toBe('invalid');
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(tokens.reset).not.toHaveBeenCalled();
  });

  it('reset: applies the hash, clears the lockout, queues the notice once per token', async () => {
    const { service, hasher, tokens, queue, loginThrottle } = setup();
    expect(await service.resetPassword('t', 'new password 1')).toBe('reset');
    expect(hasher.hash).toHaveBeenCalledWith('new password 1');
    expect(tokens.reset).toHaveBeenCalledWith('t', '$argon2id$v=19$stub');
    expect(loginThrottle.recordSuccess).toHaveBeenCalledWith('sara@example.com');
    expect(queue.enqueue).toHaveBeenCalledWith(
      PASSWORD_CHANGED_EMAIL_JOB,
      { userId: USER_ID },
      { jobId: 'identity-password-changed-0190d7a0-0000-7000-8000-0000000000cc' },
    );
  });

  it('reset: lost race inside the transaction → invalid, nothing else happens', async () => {
    const { service, queue, loginThrottle } = setup({ result: { kind: 'invalid' } });
    expect(await service.resetPassword('t', 'new password 1')).toBe('invalid');
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(loginThrottle.recordSuccess).not.toHaveBeenCalled();
  });

  it('reset: a failing notice or lockout clear does not undo a successful reset', async () => {
    const { service, queue, loginThrottle } = setup();
    queue.enqueue.mockRejectedValueOnce(new Error('queue down'));
    loginThrottle.recordSuccess.mockRejectedValueOnce(new Error('redis down'));
    expect(await service.resetPassword('t', 'new password 1')).toBe('reset');
  });
});
