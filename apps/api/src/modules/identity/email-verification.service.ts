import { Injectable } from '@nestjs/common';
import type { ClientDescription } from '@habit/shared-types';
import { PrismaService } from '../../database/index.js';
import { UNKNOWN_CLIENT } from './client-description.js';
import { EMAIL_VERIFICATION_POLICY } from './email-verification.policy.js';
import { hashSecretToken, issueSecretToken } from './secret-token.js';
import { SecurityEventService } from './security-events.service.js';

export type ConfirmResult = 'verified' | 'invalid';

/**
 * Email-verification tokens (backlog P2-04, ADR-0017, ADR-0021) in `user_tokens`
 * (`purpose = email_verification`): a 256-bit random token goes into the emailed link exactly
 * once; the database keeps only its SHA-256.
 *
 * - **Single use, expiring:** a token verifies once, within its lifetime, for the address it was
 *   issued for (`user_tokens.email` must still equal `users.email`, so changing the address later
 *   kills older links).
 * - **Latest link only:** issuing a token deletes the user's unused verification tokens, and a
 *   successful verification deletes the rest, so an older email can never be used.
 * - **Indistinguishable failures:** unknown, malformed, expired, used, superseded, wrong-address
 *   and deleted-account tokens all give `invalid`.
 * - **Race-safe:** consumption is a conditional update inside a transaction; of two concurrent
 *   confirmations exactly one succeeds.
 * - **Audited:** a verification records an `email_verified` security event in the same
 *   transaction (P2-08, ADR-0023).
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: SecurityEventService,
  ) {}

  /**
   * Creates a token for `email` (the account's current address) and invalidates every earlier
   * unused one. Returns the token for the link — never persist or log it.
   */
  async issue(
    userId: string,
    email: string,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token, hash } = issueSecretToken();
    const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_POLICY.tokenLifetimeMs);
    await this.prisma.$transaction([
      this.prisma.userToken.deleteMany({
        where: { userId, purpose: 'email_verification', consumedAt: null },
      }),
      this.prisma.userToken.create({
        data: {
          userId,
          purpose: 'email_verification',
          tokenHash: hash,
          email,
          createdAt: now,
          expiresAt,
        },
        select: { id: true },
      }),
    ]);
    return { token, expiresAt };
  }

  /** Verifies the address the presented token was issued for, at most once. */
  async confirm(
    presented: unknown,
    client: ClientDescription = UNKNOWN_CLIENT,
    now = new Date(),
  ): Promise<ConfirmResult> {
    const tokenHash = hashSecretToken(presented);
    if (!tokenHash) return 'invalid';
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.userToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          purpose: true,
          email: true,
          expiresAt: true,
          consumedAt: true,
          user: { select: { email: true, deletedAt: true } },
        },
      });
      if (
        !row ||
        row.purpose !== 'email_verification' ||
        row.consumedAt !== null ||
        row.expiresAt.getTime() <= now.getTime() ||
        row.user.deletedAt !== null ||
        row.email === null ||
        row.email.toLowerCase() !== row.user.email.toLowerCase()
      ) {
        return 'invalid';
      }
      const consumed = await tx.userToken.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return 'invalid'; // used concurrently
      const verified = await tx.user.updateMany({
        where: { id: row.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      await tx.userToken.deleteMany({
        where: { userId: row.userId, purpose: 'email_verification', consumedAt: null },
      });
      if (verified.count === 1) {
        await this.events.record(tx, row.userId, 'email_verified', client, now);
      }
      return 'verified';
    });
  }
}
