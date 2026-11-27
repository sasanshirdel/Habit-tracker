import { argon2Sync, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AuthenticatedUser,
  LoginResponse,
  RegisterRequest,
  RegistrationAcceptedResponse,
} from '@habit/shared-types';
import type { Locale } from '@habit/localization';
import { signInCredentialsSchema, signUpCredentialsSchema } from '@habit/shared-validation';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';
import { ApiException } from '../../common/errors/api-exception.js';
import type { PrismaService } from '../../database/index.js';
import {
  authenticatedUserSchema,
  loginBodySchema,
  loginResponseSchema,
  registerBodySchema,
  registrationAcceptedResponseSchema,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { PASSWORD_HASH_PREFIX, SESSION_ABSOLUTE_LIFETIME_MS } from './identity.constants.js';
import {
  LOGIN_LOCKOUT_POLICY,
  LoginLockedError,
  LoginThrottle,
  MemoryLoginThrottleStore,
  keyFor,
  lockMsForFailures,
  type LoginThrottleStore,
} from './login-throttle.js';
import {
  ARGON2ID_PARAMS,
  PasswordHasher,
  PasswordHashingBusyError,
  Semaphore,
  formatArgon2idHash,
  parseArgon2idHash,
} from './password-hasher.js';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-cookie.js';
import type { SessionService } from './session.service.js';

// Database CHECK `user_password_credentials_password_hash_check` (migration …_identity).
const DB_HASH_CHECK = /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

describe('PasswordHasher (Argon2id on node:crypto)', () => {
  const hasher = new PasswordHasher();

  it('uses the OWASP minimum configuration m=19 MiB, t=2, p=1 with 16-byte salt and 32-byte hash', () => {
    expect(ARGON2ID_PARAMS).toEqual({
      memoryKiB: 19_456,
      passes: 2,
      parallelism: 1,
      saltBytes: 16,
      hashBytes: 32,
    });
  });

  it('writes a PHC string the database accepts, with a fresh salt each time', async () => {
    const a = await hasher.hash('correct horse battery staple');
    const b = await hasher.hash('correct horse battery staple');
    expect(a.startsWith(`${PASSWORD_HASH_PREFIX}m=19456,t=2,p=1$`)).toBe(true);
    expect(a).toMatch(DB_HASH_CHECK);
    expect(a.length).toBeLessThanOrEqual(512);
    expect(a).not.toBe(b);
    const parsed = parseArgon2idHash(a)!;
    expect(parsed.salt).toHaveLength(16);
    expect(parsed.hash).toHaveLength(32);
  });

  it('verifies the right password only', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('correct horse battery staple', stored)).toEqual({
      valid: true,
      needsRehash: false,
    });
    expect((await hasher.verify('correct horse battery stapl', stored)).valid).toBe(false);
    expect((await hasher.verify('Correct horse battery staple', stored)).valid).toBe(false);
  });

  it('verifies the reference implementation test vector (phc-winner-argon2, Argon2id)', async () => {
    // From the reference implementation's test suite: password "password", salt "somesalt".
    const reference =
      '$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc';
    expect(await hasher.verify('password', reference)).toEqual({ valid: true, needsRehash: true });
    expect((await hasher.verify('passwore', reference)).valid).toBe(false);
  });

  it('matches the RFC 9106 §5.3 Argon2id test vector (the primitive itself)', () => {
    const tag = argon2Sync('argon2id', {
      message: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(16, 2),
      secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(tag.toString('hex')).toBe(
      '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
    );
  });

  it('treats canonically equivalent passwords as equal (NFKC)', async () => {
    const stored = await hasher.hash('caf\u00e9 au lait!');
    expect((await hasher.verify('cafe\u0301 au lait!', stored)).valid).toBe(true);
  });

  it('flags hashes made with other parameters for re-hashing', async () => {
    const salt = Buffer.alloc(16, 7);
    const old = formatArgon2idHash({
      memoryKiB: 9_216,
      passes: 4,
      parallelism: 1,
      salt,
      hash: argon2Sync('argon2id', {
        message: 'old password',
        nonce: salt,
        memory: 9_216,
        passes: 4,
        parallelism: 1,
        tagLength: 32,
      }),
    });
    expect(await hasher.verify('old password', old)).toEqual({ valid: true, needsRehash: true });
  });

  it.each([
    ['not a hash', 'plaintext-password'],
    [
      'argon2i',
      '$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
    ],
    [
      'version 16',
      '$argon2id$v=16$m=19456,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
    ],
    [
      'huge memory',
      '$argon2id$v=19$m=99999999,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
    ],
    [
      'many passes',
      '$argon2id$v=19$m=19456,t=999,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
    ],
    [
      'short salt',
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
    ],
    [
      'padded base64',
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ=$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
    ],
    ['short hash', '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$CTFh'],
  ])('never matches a corrupt or out-of-bounds stored hash (%s)', async (_name, stored) => {
    expect(parseArgon2idHash(stored)).toBeNull();
    expect(await hasher.verify('password', stored)).toEqual({ valid: false, needsRehash: false });
  });

  it('does the same Argon2id work for a missing account (dummy hash) and never matches it', async () => {
    const fresh = new PasswordHasher();
    await fresh.onModuleInit(); // dummy hash made at startup, not on the first request
    // Every Argon2 computation goes through the instance's limiter: count them.
    const limiter = (fresh as unknown as { limiter: Semaphore }).limiter;
    const run = vi.spyOn(limiter, 'run');
    const stored = await fresh.hash('the real password');
    run.mockClear();
    expect((await fresh.verify('the real password', null)).valid).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await fresh.verify('a wrong password', stored)).valid).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    run.mockRestore();
  });
});

describe('Semaphore (bounded Argon2 concurrency)', () => {
  it('runs at most `concurrency` tasks at once, in FIFO order', async () => {
    const sem = new Semaphore(2, 10);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (n: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      active--;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => sem.run(task(n))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(order.slice(2)).toEqual([3, 4, 5]);
  });

  it('refuses work beyond the queue with 503 SERVICE_UNAVAILABLE', async () => {
    const sem = new Semaphore(1, 1);
    let release!: () => void;
    const blocker = sem.run(() => new Promise<void>((r) => (release = r)));
    const queued = sem.run(async () => 'queued');
    await expect(sem.run(async () => 'overflow')).rejects.toBeInstanceOf(PasswordHashingBusyError);
    const err = new PasswordHashingBusyError();
    expect(err.getStatus()).toBe(503);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    release();
    await blocker;
    expect(await queued).toBe('queued');
  });

  it('releases the slot when a task fails', async () => {
    const sem = new Semaphore(1, 0);
    await expect(sem.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await sem.run(async () => 'next')).toBe('next');
  });
});

describe('login lockout policy', () => {
  it('locks from the 5th consecutive failure: 1, 2, 4, 8 min, then 15 min', () => {
    expect(LOGIN_LOCKOUT_POLICY.threshold).toBe(5);
    expect([1, 2, 3, 4].map(lockMsForFailures)).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 50].map((n) => lockMsForFailures(n) / 60_000)).toEqual([
      1, 2, 4, 8, 15, 15, 15,
    ]);
  });

  it('keys counters by a hash of the address, never the address', () => {
    const key = keyFor('sara@example.com');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain('sara');
    expect(key).toBe(
      createHash('sha256').update('email:sara@example.com').digest('hex').slice(0, 32),
    );
  });

  it('locks an address after the threshold, reports the wait and resets on success', async () => {
    let now = 1_000_000;
    const throttle = new LoginThrottle(new MemoryLoginThrottleStore(() => now));
    const email = 'person@example.com';
    for (let i = 0; i < 4; i++) await throttle.recordFailure(email);
    await expect(throttle.assertNotLocked(email)).resolves.toBeUndefined();
    await throttle.recordFailure(email); // 5th
    const locked = await throttle.assertNotLocked(email).catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(LoginLockedError);
    expect((locked as LoginLockedError).retryAfterSeconds).toBe(60);
    expect((locked as LoginLockedError).getStatus()).toBe(429);
    expect((locked as LoginLockedError).details).toEqual({
      retryAfterSeconds: 60,
      policy: 'login-account',
    });
    // Other addresses are unaffected.
    await expect(throttle.assertNotLocked('other@example.com')).resolves.toBeUndefined();
    now += 60_000;
    await expect(throttle.assertNotLocked(email)).resolves.toBeUndefined();
    await throttle.recordFailure(email); // 6th → 2 min
    const again = (await throttle
      .assertNotLocked(email)
      .catch((e: unknown) => e)) as LoginLockedError;
    expect(again.retryAfterSeconds).toBe(120);
    now += 120_000;
    await throttle.recordSuccess(email);
    for (let i = 0; i < 4; i++) await throttle.recordFailure(email);
    await expect(throttle.assertNotLocked(email)).resolves.toBeUndefined();
  });

  it('forgets failures an hour after the last one', async () => {
    let now = 0;
    const store = new MemoryLoginThrottleStore(() => now);
    for (let i = 0; i < 4; i++) await store.recordFailure('k');
    now += LOGIN_LOCKOUT_POLICY.failureMemorySeconds * 1000;
    expect(await store.recordFailure('k')).toEqual({ failures: 1, lockMs: 0 });
  });

  it('fails closed with 503 when the store is unavailable', async () => {
    const broken: LoginThrottleStore = {
      lockedForMs: () => Promise.reject(new Error('down')),
      recordFailure: () => Promise.reject(new Error('down')),
      reset: () => Promise.reject(new Error('down')),
    };
    const throttle = new LoginThrottle(broken);
    for (const op of [
      () => throttle.assertNotLocked('a@example.com'),
      () => throttle.recordFailure('a@example.com'),
      () => throttle.recordSuccess('a@example.com'),
    ]) {
      const error = await op().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getStatus()).toBe(503);
      expect((error as ApiException).code).toBe('SERVICE_UNAVAILABLE');
    }
  });
});

describe('session cookie', () => {
  const req = (cookie?: string) =>
    ({ headers: cookie === undefined ? {} : { cookie } }) as IncomingMessage;
  const res = () => {
    const headers = new Map<string, unknown>();
    return {
      headers,
      setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value),
    } as unknown as ServerResponse & { headers: Map<string, unknown> };
  };

  it('reads only __Host-session', () => {
    expect(readSessionCookie(req())).toBeUndefined();
    expect(readSessionCookie(req('theme=dark; __Host-session=abc_-123; x=y'))).toBe('abc_-123');
    expect(readSessionCookie(req('session=abc'))).toBeUndefined();
    expect(readSessionCookie(req('__Host-session='))).toBeUndefined();
    expect(readSessionCookie(req(`__Host-session=${'a'.repeat(300)}`))).toBeUndefined();
  });

  it('sets HttpOnly, Secure, SameSite=Lax, Path=/ and the absolute lifetime; never Domain', () => {
    const r = res();
    setSessionCookie(r, 'TOKEN');
    const cookie = r.headers.get('set-cookie') as string;
    expect(cookie).toBe(
      `__Host-session=TOKEN; Path=/; Max-Age=${SESSION_ABSOLUTE_LIFETIME_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('clears with the same attributes and Max-Age=0', () => {
    const r = res();
    clearSessionCookie(r);
    expect(r.headers.get('set-cookie')).toBe(
      '__Host-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  });
});

describe('auth request schemas', () => {
  const valid = {
    email: '  Sara@Example.com ',
    password: 'correct horse',
    locale: 'fa',
    timezone: 'Asia/Tehran',
  };

  it('normalises email and keeps the rest', () => {
    expect(registerBodySchema.parse({ ...valid, displayName: '  Sara  ' })).toEqual({
      email: 'sara@example.com',
      password: 'correct horse',
      locale: 'fa',
      timezone: 'Asia/Tehran',
      displayName: 'Sara',
    });
  });

  it.each([
    ['unknown field', { ...valid, isAdmin: true }],
    ['short password', { ...valid, password: 'short' }],
    ['long password', { ...valid, password: 'x'.repeat(129) }],
    ['bad email', { ...valid, email: 'not-an-email' }],
    ['unsupported locale', { ...valid, locale: 'de' }],
    ['offset time zone', { ...valid, timezone: '+03:30' }],
    ['empty display name', { ...valid, displayName: '   ' }],
    ['long display name', { ...valid, displayName: 'x'.repeat(101) }],
    ['missing locale', { email: valid.email, password: valid.password, timezone: valid.timezone }],
  ])('rejects registration with %s', (_name, body) => {
    expect(registerBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts exactly what the shared form schemas accept (web forms, P2-09)', () => {
    const cases = [
      { email: 'a@example.com', password: 'x' },
      { email: 'a@example.com', password: '' },
      { email: ' A@Example.com ', password: 'correct horse' },
      { email: 'nope', password: 'correct horse' },
      { email: 'a@example.com', password: 'x'.repeat(129) },
    ];
    for (const credentials of cases) {
      expect(loginBodySchema.safeParse(credentials).success).toBe(
        signInCredentialsSchema.safeParse(credentials).success,
      );
      expect(
        registerBodySchema.safeParse({ ...credentials, locale: 'en', timezone: 'UTC' }).success,
      ).toBe(signUpCredentialsSchema.safeParse(credentials).success);
    }
  });

  it('bounds but does not policy-check the sign-in password', () => {
    expect(loginBodySchema.safeParse({ email: 'a@example.com', password: 'short' }).success).toBe(
      true,
    );
    expect(loginBodySchema.safeParse({ email: 'a@example.com', password: '' }).success).toBe(false);
    expect(
      loginBodySchema.safeParse({ email: 'a@example.com', password: 'x', remember: true }).success,
    ).toBe(false);
  });

  it('mirrors the @habit/shared-types contracts exactly', () => {
    expectTypeOf<z.input<typeof registerBodySchema>>().toEqualTypeOf<RegisterRequest>();
    expectTypeOf<RegisterRequest['locale']>().toEqualTypeOf<Locale>();
    expectTypeOf<
      z.output<typeof registrationAcceptedResponseSchema>
    >().toEqualTypeOf<RegistrationAcceptedResponse>();
    expectTypeOf<z.output<typeof authenticatedUserSchema>>().toEqualTypeOf<AuthenticatedUser>();
    expectTypeOf<z.output<typeof loginResponseSchema>>().toEqualTypeOf<LoginResponse>();
  });
});

describe('AuthService enumeration resistance (no database)', () => {
  function setup(user: unknown) {
    const verify = vi.fn(async (_pw: string, stored: string | null) => ({
      valid: stored === 'STORED' && _pw === 'right password',
      needsRehash: false,
    }));
    const hasher = { verify, hash: vi.fn(async () => 'HASH') } as unknown as PasswordHasher;
    const throttle = new LoginThrottle(new MemoryLoginThrottleStore());
    const sessions = {
      create: vi.fn(async () => ({ token: 'TOKEN', expiresAt: new Date() })),
      revokeToken: vi.fn(async () => true),
    } as unknown as SessionService;
    const prisma = {
      user: { findFirst: vi.fn(async () => user) },
    } as unknown as PrismaService;
    const unused = {} as never; // queue, verification and resend throttle: not used by sign-in
    return {
      service: new AuthService(prisma, hasher, throttle, sessions, unused, unused, unused),
      verify,
      sessions,
    };
  }
  const account = {
    id: '0190d7a0-0000-7000-8000-000000000001',
    email: 'sara@example.com',
    emailVerifiedAt: null,
    passwordCredential: { passwordHash: 'STORED' },
  };

  it('spends one verification against the dummy hash for an unknown address', async () => {
    const { service, verify, sessions } = setup(null);
    const result = await service.login({ email: 'nobody@example.com', password: 'x' }, undefined);
    expect(result).toEqual({ kind: 'invalid-credentials' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith('x', null);
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('spends one verification for an account without a password (Google-only later)', async () => {
    const { service, verify } = setup({ ...account, passwordCredential: null });
    expect(await service.login({ email: account.email, password: 'x' }, undefined)).toEqual({
      kind: 'invalid-credentials',
    });
    expect(verify).toHaveBeenCalledWith('x', null);
  });

  it('gives a wrong password the identical result', async () => {
    const { service, verify } = setup(account);
    expect(await service.login({ email: account.email, password: 'wrong' }, undefined)).toEqual({
      kind: 'invalid-credentials',
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('opens a session and rotates a presented one on success', async () => {
    const { service, sessions } = setup(account);
    const result = await service.login(
      { email: account.email, password: 'right password' },
      'previous-token',
    );
    expect(result).toEqual({
      kind: 'signed-in',
      token: 'TOKEN',
      user: { id: account.id, email: account.email, emailVerified: false },
    });
    expect(sessions.revokeToken).toHaveBeenCalledWith('previous-token', 'rotated');
    expect(sessions.create).toHaveBeenCalledWith(account.id);
  });

  it('locks unknown and known addresses alike after repeated failures', async () => {
    for (const user of [null, account]) {
      const { service, verify } = setup(user);
      for (let i = 0; i < LOGIN_LOCKOUT_POLICY.threshold; i++) {
        await service.login({ email: 'x@example.com', password: 'wrong' }, undefined);
      }
      await expect(
        service.login({ email: 'x@example.com', password: 'right password' }, undefined),
      ).rejects.toBeInstanceOf(LoginLockedError);
      // The locked attempt is refused before any password work.
      expect(verify).toHaveBeenCalledTimes(LOGIN_LOCKOUT_POLICY.threshold);
    }
  });
});
