import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ClientDescription } from '@habit/shared-types';
import { ApiException } from '../../common/errors/api-exception.js';
import { PrismaService } from '../../database/index.js';
import { QueueProducer } from '../../queue/queue-producer.service.js';
import { ACCOUNT_DELETED_EMAIL_JOB, purgeAfter } from './account-deletion.policy.js';
import { UNKNOWN_CLIENT } from './client-description.js';
import { LoginThrottle } from './login-throttle.js';
import { PasswordHasher } from './password-hasher.js';
import { SecurityEventService } from './security-events.service.js';

/** Thrown when the password presented to confirm a sensitive action is wrong. */
export class ReauthenticationFailedError extends ApiException {
  constructor() {
    super(
      HttpStatus.FORBIDDEN,
      'REAUTHENTICATION_FAILED',
      'The password does not match this account.',
    );
  }
}

/**
 * Account deletion, API side (backlog P2-10, ADR-0025).
 *
 * 1. **Re-authentication:** the current password is verified (one Argon2id verification), with the
 *    per-address sign-in lockout of ADR-0018 on top of the `sensitive` rate-limit class, so a
 *    stolen session cannot guess the password here faster than at sign-in. Wrong → 403
 *    `REAUTHENTICATION_FAILED` (not 401: the session itself is fine). An account without a
 *    password (Google sign-in, P2-06) cannot re-authenticate this way yet.
 * 2. **One transaction:** `users.deleted_at` is set (soft delete; the address stays reserved,
 *    ADR-0017), **every** session ends (`account_deleted`), outstanding emailed links (verification,
 *    reset, restore) are deleted, and an `account_deletion_requested` security event is recorded.
 *    From then on sign-in, sessions, password reset and verification all treat the account as
 *    non-existent.
 * 3. **After commit:** `identity.account-deleted-email` is queued (best effort, logged without
 *    personal data on failure); the worker emails the confirmation with a restore link valid until
 *    the purge.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger('AccountDeletion');

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly throttle: LoginThrottle,
    private readonly events: SecurityEventService,
    private readonly queue: QueueProducer,
  ) {}

  async requestDeletion(
    userId: string,
    password: string,
    client: ClientDescription = UNKNOWN_CLIENT,
    now = new Date(),
  ): Promise<{ purgeAfter: Date; sessionsEnded: number }> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true, passwordCredential: { select: { passwordHash: true } } },
    });
    if (!user) throw unauthenticated(); // deleted concurrently: the session no longer counts
    await this.throttle.assertNotLocked(user.email);
    const verification = await this.hasher.verify(
      password,
      user.passwordCredential?.passwordHash ?? null,
    );
    if (!verification.valid) {
      await this.throttle.recordFailure(user.email);
      throw new ReauthenticationFailedError();
    }
    await this.throttle.recordSuccess(user.email);

    const sessionsEnded = await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.user.updateMany({
        where: { id: userId, deletedAt: null },
        data: { deletedAt: now },
      });
      if (deleted.count !== 1) return null;
      const revoked = await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'account_deleted' },
      });
      await tx.userToken.deleteMany({ where: { userId, consumedAt: null } });
      await this.events.record(tx, userId, 'account_deletion_requested', client, now);
      return revoked.count;
    });
    if (sessionsEnded === null) throw unauthenticated();

    await this.queueConfirmation(userId);
    return { purgeAfter: purgeAfter(now), sessionsEnded };
  }

  private async queueConfirmation(userId: string): Promise<void> {
    try {
      await this.queue.enqueue(ACCOUNT_DELETED_EMAIL_JOB, { userId });
    } catch (error) {
      // The deletion stands; the user cannot get the restore link by email until support resends
      // it (ADR-0025 open decision). Log the error class only.
      this.logger.warn({
        msg: 'account deleted email not queued',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

function unauthenticated(): ApiException {
  return new ApiException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Sign in required.');
}
