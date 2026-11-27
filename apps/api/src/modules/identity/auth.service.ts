import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '@habit/shared-types';
import { PrismaService } from '../../database/index.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import { LoginThrottle } from './login-throttle.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionService } from './session.service.js';

export type LoginResult =
  | { readonly kind: 'signed-in'; readonly user: AuthenticatedUser; readonly token: string }
  | { readonly kind: 'invalid-credentials' };

/**
 * Email/password registration and sign-in (backlog P2-02, ADR-0018).
 *
 * Enumeration resistance:
 * - **Registration** answers the same whether or not the address is taken, and always spends one
 *   Argon2id hash first, so neither the response nor its timing says whether an account exists.
 *   A taken address is left untouched. (P2-04 adds the email that tells the real owner.)
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
  ) {}

  /** Creates the account unless the address is already registered (silently, see above). */
  async register(input: RegisterInput): Promise<void> {
    // Hash first, on every path, so a taken address answers no faster than a new one.
    const passwordHash = await this.hasher.hash(input.password);
    try {
      // One nested write = one transaction: the account never exists half-created.
      await this.prisma.user.create({
        data: {
          email: input.email,
          profile: { create: { displayName: input.displayName ?? null } },
          preference: { create: { locale: input.locale, timezone: input.timezone } },
          passwordCredential: { create: { passwordHash } },
        },
        select: { id: true },
      });
    } catch (error) {
      // users.email is unique (citext, soft-deleted accounts included): the address is taken.
      if (isUniqueViolation(error)) return;
      throw error;
    }
  }

  /**
   * Verifies the credentials and opens a session. `previousToken` (the cookie the browser already
   * had, if any) is revoked as `rotated`, so a session id planted before sign-in never becomes
   * authenticated (session fixation).
   */
  async login(input: LoginInput, previousToken: string | undefined): Promise<LoginResult> {
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
    const { token } = await this.sessions.create(user.id);
    return {
      kind: 'signed-in',
      token,
      user: { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null },
    };
  }

  /** Ends the presented session, if any (idempotent). */
  async logout(token: string | undefined): Promise<void> {
    if (token !== undefined) await this.sessions.revokeToken(token, 'sign_out');
  }

  /**
   * Ends every session of the user the presented session belongs to. Returns `false` when the
   * token is not an active session (the caller answers 401).
   */
  async logoutEverywhere(token: string | undefined): Promise<{ userId: string } | null> {
    const session = await this.sessions.resolve(token);
    if (!session) return null;
    await this.sessions.revokeAllForUser(session.userId, 'sign_out_everywhere');
    return { userId: session.userId };
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
