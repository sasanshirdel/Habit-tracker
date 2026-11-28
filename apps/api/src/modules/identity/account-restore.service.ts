import { Injectable } from '@nestjs/common';
import type { ClientDescription } from '@habit/shared-types';
import { PrismaService } from '../../database/index.js';
import { purgeAfter } from './account-deletion.policy.js';
import { UNKNOWN_CLIENT } from './client-description.js';
import { hashSecretToken, issueSecretToken } from './secret-token.js';
import { SecurityEventService } from './security-events.service.js';

export type AccountRestoreResult = 'restored' | 'invalid';

/**
 * Restore links for deleted accounts (backlog P2-10, ADR-0025) in `user_tokens`
 * (`purpose = account_restore`), following the emailed-token pattern of ADR-0021/0022: a 256-bit
 * random token goes into the link exactly once, the database keeps only its SHA-256.
 *
 * - **Valid until the purge:** the token expires when the grace period ends; only the newest one
 *   works (issuing deletes the earlier unused ones).
 * - **Indistinguishable failures:** unknown, malformed, expired, used, superseded tokens and
 *   accounts that are not deleted (any more) all give `invalid`.
 * - **One transaction:** consume the token, clear `deleted_at` (only if the grace period has not
 *   passed — a purge that has not run yet does not extend it), record `account_restored`. No
 *   session is created: the user signs in with their password afterwards.
 */
@Injectable()
export class AccountRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: SecurityEventService,
  ) {}

  /** Issues a restore token for an account deleted at `deletedAt`. Never persist or log it. */
  async issue(
    userId: string,
    deletedAt: Date,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token, hash } = issueSecretToken();
    const expiresAt = purgeAfter(deletedAt);
    await this.prisma.$transaction([
      this.prisma.userToken.deleteMany({
        where: { userId, purpose: 'account_restore', consumedAt: null },
      }),
      this.prisma.userToken.create({
        data: { userId, purpose: 'account_restore', tokenHash: hash, createdAt: now, expiresAt },
        select: { id: true },
      }),
    ]);
    return { token, expiresAt };
  }

  async restore(
    presented: unknown,
    client: ClientDescription = UNKNOWN_CLIENT,
    now = new Date(),
  ): Promise<AccountRestoreResult> {
    const tokenHash = hashSecretToken(presented);
    if (!tokenHash) return 'invalid';
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.userToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          purpose: true,
          expiresAt: true,
          consumedAt: true,
          user: { select: { deletedAt: true } },
        },
      });
      const deletedAt = row?.user.deletedAt ?? null;
      if (
        !row ||
        row.purpose !== 'account_restore' ||
        row.consumedAt !== null ||
        row.expiresAt.getTime() <= now.getTime() ||
        deletedAt === null ||
        purgeAfter(deletedAt).getTime() <= now.getTime()
      ) {
        return 'invalid';
      }
      const consumed = await tx.userToken.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return 'invalid'; // used concurrently
      const restored = await tx.user.updateMany({
        where: { id: row.userId, deletedAt },
        data: { deletedAt: null },
      });
      if (restored.count !== 1) return 'invalid';
      await this.events.record(tx, row.userId, 'account_restored', client, now);
      return 'restored';
    });
  }
}
