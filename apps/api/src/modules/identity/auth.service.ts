import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser, ClientDescription } from '@habit/shared-types';
import { defaultDisplayPreferencesFor } from '@habit/shared-validation';
import { PrismaService } from '../../database/index.js';
import { Prisma } from '../../generated/prisma/client.js';
import { QueueProducer } from '../../queue/queue-producer.service.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import { UNKNOWN_CLIENT } from './client-description.js';
import { EmailVerificationService, type ConfirmResult } from './email-verification.service.js';
import { VERIFICATION_EMAIL_JOB, registrationEmailJobId } from './email-verification.policy.js';
import { LoginThrottle } from './login-throttle.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionService } from './session.service.js';
import { VerificationResendThrottle } from './verification-resend-throttle.js';

export type LoginResult =
  | { readonly kind: 'signed-in'; readonly user: AuthenticatedUser; readonly token: string }
  | { readonly kind: 'invalid-credentials' };

/**
 * Email/password registration and sign-in (backlog P2-02, ADR-0018).
 *
 * Enumeration resistance:
 * - **Registration** answers the same whether or not the address is taken, and always spends one
 *   Argon2id hash first, so neither the response nor its timing says whether an account exists.
 *   A taken address is left untouched. Either way one email job is queued for the account the
 *   address belongs to (P2-04): a verification link if it is not verified yet, a "someone tried
 *   to register with your address" notice if it is, nothing for a deleted account — decided by
 *   the worker, so this request does the same work in every case.
 * - **Sign-in** spends exactly one Argon2id verification on every path — unknown address,
 *   soft-deleted account, account without a password, wrong password, right password — and every
 *   failure is the same 401 `INVALID_CREDENTIALS`. The per-address lockout is keyed by the
 *   submitted address whether or not it exists.
 *
 * Nothing here logs an email address, password, token or hash.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly throttle: LoginThrottle,
    private readonly sessions: SessionService,
    private readonly queue: QueueProducer,
    private readonly verification: EmailVerificationService,
    private readonly resendThrottle: VerificationResendThrottle,
  ) {}

  /** Creates the account unless the address is already registered (silently, see above). */
  async register(input: RegisterInput): Promise<void> {
    // Hash first, on every path, so a taken address answers no faster than a new one.
    const passwordHash = await this.hasher.hash(input.password);
    let userId: string | undefined;
    try {
      // One nested write = one transaction: the account never exists half-created.
      const created = await this.prisma.user.create({
        data: {
          email: input.email,
          profile: { create: { displayName: input.displayName ?? null } },
          preference: {
            create: {
              locale: input.locale,
              timezone: input.timezone,
              ...defaultDisplayPreferencesFor(input.locale),
            },
          },
          passwordCredential: { create: { passwordHash } },
        },
        select: { id: true },
      });
      userId = created.id;
    } catch (error) {
      // users.email is unique (citext, soft-deleted accounts included): the address is taken.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      userId = existing?.id;
    }
    if (userId !== undefined) await this.queueRegistrationEmail(userId);
  }

  /**
   * Queues the registration email for an account (P2-04). At most one per account per window
   * (deterministic job id), so the public form cannot flood an inbox. A queue outage does not fail
   * the registration — the account exists and the user can ask for a new link after signing in —
   * and is logged without any personal data.
   */
  private async queueRegistrationEmail(userId: string): Promise<void> {
    try {
      await this.queue.enqueue(
        VERIFICATION_EMAIL_JOB,
        { userId, reason: 'registration' },
        { jobId: registrationEmailJobId(userId) },
      );
    } catch (error) {
      this.logger.warn({ msg: 'registration email not queued', errorName: errorName(error) });
    }
  }

  /**
   * "Send me a new verification link" for the signed-in user (P2-04): limited per account
   * (cooldown + hourly cap, 429 `RATE_LIMITED`), then queued. Already verified → nothing to do
   * (still 202). Queue outage → 503 `QUEUE_UNAVAILABLE` (the user can try again).
   */
  async requestVerificationEmail(userId: string, emailVerified: boolean): Promise<void> {
    if (emailVerified) return;
    await this.resendThrottle.take(userId);
    await this.queue.enqueue(VERIFICATION_EMAIL_JOB, { userId, reason: 'resend' });
  }

  /** Consumes a verification token (P2-04); see `EmailVerificationService.confirm`. */
  async confirmEmail(
    token: string,
    client: ClientDescription = UNKNOWN_CLIENT,
  ): Promise<ConfirmResult> {
    return this.verification.confirm(token, client);
  }

  /**
   * Verifies the credentials and opens a session. `previousToken` (the cookie the browser already
   * had, if any) is revoked as `rotated`, so a session id planted before sign-in never becomes
   * authenticated (session fixation). The new session carries the coarse `client` description and
   * a `sign_in` security event is recorded with it (P2-08).
   */
  async login(
    input: LoginInput,
    previousToken: string | undefined,
    client: ClientDescription = UNKNOWN_CLIENT,
  ): Promise<LoginResult> {
    await this.throttle.assertNotLocked(input.email);

    const user = await this.prisma.user.findFirst({
      where: { email: input.email, deletedAt: null },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        passwordCredential: { select: { passwordHash: true } },
      },
    });
    const stored = user?.passwordCredential?.passwordHash ?? null;
    const verification = await this.hasher.verify(input.password, stored);

    if (!user || !verification.valid) {
      await this.throttle.recordFailure(input.email);
      return { kind: 'invalid-credentials' };
    }

    await this.throttle.recordSuccess(input.email);
    if (verification.needsRehash) await this.upgradeHash(user.id, input.password);
    if (previousToken !== undefined) await this.sessions.revokeToken(previousToken, 'rotated');
    const { token } = await this.sessions.create(user.id, client);
    return {
      kind: 'signed-in',
      token,
      user: { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null },
    };
  }

  /** Ends the presented session, if any (idempotent); records `sign_out` when one ended. */
  async logout(
    token: string | undefined,
    client: ClientDescription = UNKNOWN_CLIENT,
  ): Promise<void> {
    if (token !== undefined) {
      await this.sessions.revokeToken(token, 'sign_out', { event: 'sign_out', client });
    }
  }

  /**
   * Ends every open session of the signed-in user (the `AuthGuard` has already resolved the
   * presented session) and records `signed_out_everywhere`. Returns how many were ended.
   */
  async logoutEverywhere(
    userId: string,
    client: ClientDescription = UNKNOWN_CLIENT,
  ): Promise<number> {
    return this.sessions.revokeAllForUser(userId, 'sign_out_everywhere', {
      event: 'signed_out_everywhere',
      client,
    });
  }

  /**
   * The signed-in account for `GET /auth/session`, or `null` if it disappeared between the guard's
   * session check and this read (deleted concurrently).
   */
  async currentUser(userId: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    return user
      ? { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null }
      : null;
  }

  /** Re-hashes with the current parameters after a successful sign-in (best effort). */
  private async upgradeHash(userId: string, password: string): Promise<void> {
    try {
      const passwordHash = await this.hasher.hash(password);
      await this.prisma.userPasswordCredential.update({
        where: { userId },
        data: { passwordHash },
      });
    } catch (error) {
      // Not fatal: the old hash still verifies. Log the error class only.
      this.logger.warn({ msg: 'password hash upgrade failed', errorName: errorName(error) });
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
