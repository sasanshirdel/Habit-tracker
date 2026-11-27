import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/index.js';
import { PASSWORD_RESET_POLICY } from './password-reset.policy.js';
import { hashSecretToken, issueSecretToken } from './secret-token.js';

/** Outcome of presenting a reset token with a new password. */
export type PasswordResetResult =
  | {
      readonly kind: 'reset';
      readonly userId: string;
      /** The account's (normalised) address, for clearing its sign-in lockout. Never log it. */
      readonly email: string;
      /** Id of the consumed token row: idempotency key of the "password changed" notice. */
      readonly tokenId: string;
      readonly sessionsRevoked: number;
    }
  | { readonly kind: 'invalid' };

/** Token row fields the reset checks. */
interface ResetTokenRow {
  id: string;
  userId: string;
  purpose: string;
  email: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  user: { email: string; deletedAt: Date | null };
}

function usable(row: ResetTokenRow | null, now: Date): row is ResetTokenRow {
  return (
    row !== null &&
    row.purpose === 'password_reset' &&
    row.consumedAt === null &&
    row.expiresAt.getTime() > now.getTime() &&
    row.user.deletedAt === null &&
    row.email !== null &&
    row.email.toLowerCase() === row.user.email.toLowerCase()
  );
}

const ROW_SELECT = {
  id: true,
  userId: true,
  purpose: true,
  email: true,
  expiresAt: true,
  consumedAt: true,
  user: { select: { email: true, deletedAt: true } },
} as const;

/**
 * Password-reset tokens (backlog P2-05, ADR-0022) in `user_tokens` (`purpose = password_reset`),
 * following the verification-token pattern of ADR-0021: a 256-bit random token goes into the
 * emailed link exactly once, the database keeps only its SHA-256.
 *
 * - **Short-lived, single use, bound to the address:** {@link PASSWORD_RESET_POLICY.tokenLifetimeMs},
 *   consumed by a conditional update (of concurrent resets exactly one wins), and only while
 *   `user_tokens.email` still equals `users.email`.
 * - **Newest link only:** issuing deletes the user's unused reset tokens; a successful reset deletes
 *   the rest.
 * - **Indistinguishable failures:** unknown, malformed, expired, used, superseded, wrong-address
 *   and deleted-account tokens all give `invalid`.
 * - **One transaction** for a successful reset: consume the token, store the new Argon2id hash
 *   (creating the credential if the account had none), revoke **every** open session
 *   (`password_changed`), delete the other unused reset tokens, and mark the address verified
 *   (the token proves control of it; unused verification links are then deleted).
 */
@Injectable()
export class PasswordResetService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a reset token for `email` (the account's current address) and invalidates every
   * earlier unused one. Returns the token for the link — never persist or log it.
   */
  async issue(
    userId: string,
    email: string,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token, hash } = issueSecretToken();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_POLICY.tokenLifetimeMs);
    await this.prisma.$transaction([
      this.prisma.userToken.deleteMany({
        where: { userId, purpose: 'password_reset', consumedAt: null },
      }),
      this.prisma.userToken.create({
        data: {
          userId,
          purpose: 'password_reset',
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

  /**
   * Whether a presented token could reset a password right now (no side effects). Lets the caller
   * skip the expensive password hash for links that are dead anyway; {@link reset} checks again
   * inside its transaction.
   */
  async isUsable(presented: unknown, now = new Date()): Promise<boolean> {
    const tokenHash = hashSecretToken(presented);
    if (!tokenHash) return false;
    const row = await this.prisma.userToken.findUnique({
      where: { tokenHash },
      select: ROW_SELECT,
    });
    return usable(row, now);
  }

  /** Sets the new password (already an Argon2id PHC string) if the token is still usable. */
  async reset(
    presented: unknown,
    passwordHash: string,
    now = new Date(),
  ): Promise<PasswordResetResult> {
    const tokenHash = hashSecretToken(presented);
    if (!tokenHash) return { kind: 'invalid' };
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.userToken.findUnique({ where: { tokenHash }, select: ROW_SELECT });
      if (!usable(row, now)) return { kind: 'invalid' } as const;
      const consumed = await tx.userToken.updateMany({
        where: { id: row.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return { kind: 'invalid' } as const; // used concurrently

      await tx.userPasswordCredential.upsert({
        where: { userId: row.userId },
        create: { userId: row.userId, passwordHash },
        update: { passwordHash },
      });
      const revoked = await tx.userSession.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'password_changed' },
      });
      // Other reset links die with this one; the address is proven, so it is verified (once) and
      // any outstanding verification links are pointless.
      await tx.userToken.deleteMany({
        where: {
          userId: row.userId,
          consumedAt: null,
          purpose: { in: ['password_reset', 'email_verification'] },
        },
      });
      await tx.user.updateMany({
        where: { id: row.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      return {
        kind: 'reset',
        userId: row.userId,
        email: row.user.email,
        tokenId: row.id,
        sessionsRevoked: revoked.count,
      } as const;
    });
  }
}
