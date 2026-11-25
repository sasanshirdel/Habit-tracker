import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/index.js';
import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from './identity.constants.js';
import { hashSecretToken, issueSecretToken } from './secret-token.js';

/** An active session, as resolved from a presented token. */
export interface ActiveSession {
  readonly sessionId: string;
  readonly userId: string;
}

/** Why sessions were ended (subset of `SessionRevocationReason` used so far). */
type RevocationReason = 'sign_out' | 'sign_out_everywhere' | 'rotated';

/**
 * Server-side customer sessions (backlog P2-02, ADR-0017/0018). The client holds a 256-bit random
 * token in the `__Host-session` cookie; the database holds only its SHA-256 hash. Malformed and
 * unknown tokens are indistinguishable (both resolve to `null`).
 *
 * P2-02 uses `resolve` only for sign-out-everywhere. P2-03 builds the deny-by-default
 * authentication guard and `@CurrentUser()` on it.
 */
@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a session and returns the token for the cookie (the only place it ever exists). */
  async create(userId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    const { token, hash } = issueSecretToken();
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_LIFETIME_MS);
    await this.prisma.userSession.create({
      data: { userId, tokenHash: hash, createdAt: now, lastUsedAt: now, expiresAt },
    });
    return { token, expiresAt };
  }

  /**
   * The active session for a presented token: not revoked, before its absolute expiry, used within
   * the idle timeout, and belonging to an account that is not deleted. Refreshes `last_used_at`
   * at most once per {@link SESSION_TOUCH_INTERVAL_MS}.
   */
  async resolve(presented: unknown, now = new Date()): Promise<ActiveSession | null> {
    const tokenHash = hashSecretToken(presented);
    if (!tokenHash) return null;
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        user: { select: { deletedAt: true } },
      },
    });
    if (
      !session ||
      session.revokedAt !== null ||
      session.user.deletedAt !== null ||
      session.expiresAt.getTime() <= now.getTime() ||
      session.lastUsedAt.getTime() + SESSION_IDLE_TIMEOUT_MS <= now.getTime()
    ) {
      return null;
    }
    if (now.getTime() - session.lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      await this.prisma.userSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { lastUsedAt: now },
      });
    }
    return { sessionId: session.id, userId: session.userId };
  }

  /**
   * Ends the session a presented token belongs to, if it is still open. Returns whether one was
   * ended. Unknown or malformed tokens do nothing.
   */
  async revokeToken(
    presented: unknown,
    reason: RevocationReason,
    now = new Date(),
  ): Promise<boolean> {
    const tokenHash = hashSecretToken(presented);
    if (!tokenHash) return false;
    const { count } = await this.prisma.userSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    return count > 0;
  }

  /** Ends every open session of a user ("sign out everywhere"). Returns how many were ended. */
  async revokeAllForUser(
    userId: string,
    reason: RevocationReason,
    now = new Date(),
  ): Promise<number> {
    const { count } = await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    return count;
  }
}
