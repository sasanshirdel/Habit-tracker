import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { ClientDescription } from '@habit/shared-types';
import { PrismaService } from '../../database/index.js';
import { OutageLogger } from '../../queue/outage-logger.js';
import { QueueProducer } from '../../queue/queue-producer.service.js';
import { UNKNOWN_CLIENT } from './client-description.js';
import { LoginThrottle, keyFor } from './login-throttle.js';
import { PasswordHasher } from './password-hasher.js';
import {
  PASSWORD_CHANGED_EMAIL_JOB,
  PASSWORD_RESET_EMAIL_JOB,
  PASSWORD_RESET_REQUEST_LIMITS,
} from './password-reset.policy.js';
import { PasswordResetService } from './password-reset.service.js';
import { RESEND_THROTTLE_STORE, type ResendThrottleStore } from './verification-resend-throttle.js';

/** What a background reset request decided (tests and the log line; no personal data). */
export type ResetRequestOutcome = 'queued' | 'no-account' | 'throttled' | 'failed';

export type ResetPasswordOutcome = 'reset' | 'invalid';

/**
 * Password recovery, API side (backlog P2-05, ADR-0022).
 *
 * **Request** (`POST /auth/password-reset/request`) is public and must not reveal whether an
 * address has an account — neither by its answer nor by how long the answer takes. So the request
 * handler only validates the body and answers 202; everything that depends on the address runs
 * **after** the response, in {@link requestReset}'s background task:
 *
 * 1. the per-address limit (1/min, 5/h, keyed by a truncated SHA-256 of the address — counted
 *    for every address, registered or not; fails closed: no email when Redis is down),
 * 2. the account lookup (deleted accounts and unknown addresses → nothing),
 * 3. queueing `identity.password-reset-email` with the account id only.
 *
 * Failures there are logged without personal data and never reach the client.
 *
 * **Reset** (`POST /auth/password-reset/confirm`) hashes the new password only for a usable token,
 * then {@link PasswordResetService.reset} applies it with session revocation in one transaction.
 * Afterwards the per-address sign-in lockout is cleared (the owner just proved control of the
 * address) and the "your password was changed" notice is queued (best effort, logged on failure).
 * It does **not** sign in.
 */
@Injectable()
export class PasswordRecoveryService implements OnApplicationShutdown {
  private readonly logger = new Logger('PasswordRecovery');
  private readonly outage = new OutageLogger(this.logger, 'Password reset throttle');
  private readonly inFlight = new Set<Promise<ResetRequestOutcome>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly tokens: PasswordResetService,
    private readonly queue: QueueProducer,
    private readonly loginThrottle: LoginThrottle,
    @Inject(RESEND_THROTTLE_STORE) private readonly limits: ResendThrottleStore,
  ) {}

  /**
   * Starts the work of a reset request in the background and returns at once, so the response
   * is the same — in body and timing — for every address. Returns the background task for tests;
   * the controller ignores it.
   */
  requestReset(email: string): Promise<ResetRequestOutcome> {
    const task = this.processRequest(email).catch((error: unknown) => {
      this.logger.warn({ msg: 'password reset request failed', errorName: errorName(error) });
      return 'failed' as const;
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
    return task;
  }

  /** Resolves when every background request started so far has finished. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Lets queued background requests finish before the process exits. */
  async onApplicationShutdown(): Promise<void> {
    await this.settled();
  }

  private async processRequest(email: string): Promise<ResetRequestOutcome> {
    const outcome = await this.decide(email);
    this.logger.log({ msg: 'password reset request', outcome });
    return outcome;
  }

  private async decide(email: string): Promise<ResetRequestOutcome> {
    // The limit is taken for every submitted address — registered or not — before the lookup.
    let waitMs: number;
    try {
      waitMs = await this.limits.take(keyFor(email), PASSWORD_RESET_REQUEST_LIMITS);
      this.outage.ready();
    } catch (error) {
      this.outage.error(error);
      return 'failed'; // fail closed: without the limit, the form could flood an inbox
    }
    if (waitMs > 0) return 'throttled';

    const user = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
    if (!user) return 'no-account';
    await this.queue.enqueue(PASSWORD_RESET_EMAIL_JOB, { userId: user.id });
    return 'queued';
  }

  /** Sets a new password with an emailed reset token (see the class comment). */
  async resetPassword(
    token: string,
    password: string,
    client: ClientDescription = UNKNOWN_CLIENT,
  ): Promise<ResetPasswordOutcome> {
    // Hash only for a link that can still work (Argon2id is deliberately expensive).
    if (!(await this.tokens.isUsable(token))) return 'invalid';
    const passwordHash = await this.hasher.hash(password);
    const result = await this.tokens.reset(token, passwordHash, client);
    if (result.kind !== 'reset') return 'invalid';
    this.logger.log({
      msg: 'password reset',
      userId: result.userId,
      sessionsRevoked: result.sessionsRevoked,
    });

    try {
      await this.loginThrottle.recordSuccess(result.email);
    } catch (error) {
      // The password is changed either way; a lockout simply runs out (≤ 15 min).
      this.logger.warn({ msg: 'sign-in lockout not cleared', errorName: errorName(error) });
    }
    try {
      await this.queue.enqueue(
        PASSWORD_CHANGED_EMAIL_JOB,
        { userId: result.userId },
        { jobId: `identity-password-changed-${result.tokenId}` },
      );
    } catch (error) {
      this.logger.warn({ msg: 'password changed notice not queued', errorName: errorName(error) });
    }
    return 'reset';
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
