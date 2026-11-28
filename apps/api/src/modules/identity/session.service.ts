import { Injectable } from '@nestjs/common';
import {
  ENDED_SESSION_RETENTION_DAYS,
  type AccountSession,
  type AccountSessionList,
  type ClientDescription,
  type SecurityEventType,
} from '@habit/shared-types';
import { decodeCursor, paginate } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/index.js';
import { idCursorSchema } from './account.schemas.js';
import { UNKNOWN_CLIENT, clientColumns, clientFromColumns } from './client-description.js';
import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from './identity.constants.js';
import { hashSecretToken, issueSecretToken } from './secret-token.js';
import { SecurityEventService, type IdentityDb } from './security-events.service.js';

export const ENDED_SESSION_RETENTION_MS = ENDED_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** An active session, as resolved from a presented token. */
export interface ActiveSession {
  readonly sessionId: string;
  readonly userId: string;
  /** Whether the account's email address is verified (P2-04), read with the session. */
  readonly emailVerified: boolean;
}

/** Why sessions were ended (subset of `SessionRevocationReason` set by this service). */
type RevocationReason = 'sign_out' | 'sign_out_everywhere' | 'rotated' | 'revoked_by_user';

/** The security event to write with a revocation, and the client that asked for it (P2-08). */
interface RevocationAudit {
  readonly event: SecurityEventType;
  readonly client: ClientDescription;
}

/** `where` for sessions that still work at `now`: not revoked, not expired, not idle-expired. */
function activeAt(now: Date) {
  return {
    revokedAt: null,
    expiresAt: { gt: now },
    lastUsedAt: { gt: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS) },
  };
}

/**
 * `where` for sessions that ended before `cutoff`: revoked, past their absolute expiry, or idle
 * for longer than the idle timeout. Used by the per-account purge on sign-in and by the global
 * retention clean-up (ADR-0023, ADR-0026), so both delete exactly the same rows.
 */
export function endedBefore(cutoff: Date) {
  return {
    OR: [
      { revokedAt: { lt: cutoff } },
      { expiresAt: { lt: cutoff } },
      { lastUsedAt: { lt: new Date(cutoff.getTime() - SESSION_IDLE_TIMEOUT_MS) } },
    ],
  };
}

/**
 * Server-side customer sessions (backlog P2-02, ADR-0017/0018). The client holds a 256-bit random
 * token in the `__Host-session` cookie; the database holds only its SHA-256 hash. Malformed and
 * unknown tokens are indistinguishable (both resolve to `null`).
 *
 * P2-02 uses `resolve` only for sign-out-everywhere. P2-03 builds the deny-by-default
 * authentication guard and `@CurrentUser()` on it. P2-08 (ADR-0023) adds the coarse client
 * description, the user's session list and revocation, security events written in the same
 * transaction as each sign-in and revocation, and the retention of ended sessions.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: SecurityEventService,
  ) {}

  /**
   * Creates a session and returns the token for the cookie (the only place it ever exists). In one
   * transaction: the account's sessions that ended more than {@link ENDED_SESSION_RETENTION_DAYS}
   * days ago are deleted, the session is created and a `sign_in` event is recorded.
   */
  async create(
    userId: string,
    client: ClientDescription = UNKNOWN_CLIENT,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token, hash } = issueSecretToken();
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_LIFETIME_MS);
    await this.prisma.$transaction(async (tx) => {
      await this.purgeEnded(tx, userId, now);
      await tx.userSession.create({
        data: {
          userId,
          tokenHash: hash,
          createdAt: now,
          lastUsedAt: now,
          expiresAt,
          ...clientColumns(client),
        },
        select: { id: true },
      });
      await this.events.record(tx, userId, 'sign_in', client, now);
    });
    return { token, expiresAt };
  }

  /**
   * Deletes the account's sessions that ended (revoked, expired or idle-expired) more than the
   * retention window ago. Runs on every sign-in of the account (ADR-0023).
   */
  private async purgeEnded(db: IdentityDb, userId: string, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - ENDED_SESSION_RETENTION_MS);
    await db.userSession.deleteMany({
      where: { userId, ...endedBefore(cutoff) },
    });
  }

  /**
   * The user's active sessions, newest sign-in first (keyset on the UUIDv7 id), with `current` on
   * `currentSessionId`. Owner-scoped: only `userId`'s rows are read.
   */
  async listActive(
    userId: string,
    currentSessionId: string,
    page: { limit: number; cursor?: string | undefined },
    now = new Date(),
  ): Promise<AccountSessionList> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor, idCursorSchema);
    const rows = await this.prisma.userSession.findMany({
      where: { userId, ...activeAt(now), ...(after ? { id: { lt: after.id } } : {}) },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        clientBrowser: true,
        clientOs: true,
        clientDevice: true,
      },
    });
    const sessions: AccountSession[] = rows.map((row) => ({
      id: row.id,
      current: row.id === currentSessionId,
      client: clientFromColumns(row),
      createdAt: row.createdAt.toISOString(),
      lastActiveAt: row.lastUsedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }));
    return paginate(sessions, page.limit, (last) => ({ id: last.id }));
  }

  /**
   * Ends one active session of `userId` (`revoked_by_user`) and records `audit.event`. Returns
   * `false` — the caller answers 404 — when no such active session belongs to the user (another
   * user's, unknown, already ended).
   */
  async revokeOwned(
    userId: string,
    sessionId: string,
    reason: RevocationReason,
    audit: RevocationAudit,
    now = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.userSession.updateMany({
        where: { id: sessionId, userId, ...activeAt(now) },
        data: { revokedAt: now, revokedReason: reason },
      });
      if (count !== 1) return false;
      await this.events.record(tx, userId, audit.event, audit.client, now);
      return true;
    });
  }

  /** Ends every open session of `userId` except `keepSessionId`; records `audit.event`. */
  async revokeOthers(
    userId: string,
    keepSessionId: string,
    audit: RevocationAudit,
    now = new Date(),
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.userSession.updateMany({
        where: { userId, revokedAt: null, id: { not: keepSessionId } },
        data: { revokedAt: now, revokedReason: 'revoked_by_user' },
      });
      await this.events.record(tx, userId, audit.event, audit.client, now);
      return count;
    });
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
        user: { select: { deletedAt: true, emailVerifiedAt: true } },
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
    return {
      sessionId: session.id,
      userId: session.userId,
      emailVerified: session.user.emailVerifiedAt !== null,
    };
  }

  /**
   * Ends the session a presented token belongs to, if it is still open, and records
   * `audit.event` for its owner when given (sign-out; rotation records nothing). Returns whether
   * one was ended. Unknown or malformed tokens do nothing.
   */
  async revokeToken(
    presented: unknown,
    reason: RevocationReason,
    audit?: RevocationAudit,
    now = new Date(),
  ): Promise<boolean> {
    const tokenHash = hashSecretToken(presented);
    if (!tokenHash) return false;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.userSession.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, revokedAt: true },
      });
      if (!row || row.revokedAt !== null) return false;
      const { count } = await tx.userSession.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      });
      if (count !== 1) return false;
      if (audit) await this.events.record(tx, row.userId, audit.event, audit.client, now);
      return true;
    });
  }

  /**
   * Ends every open session of a user ("sign out everywhere") and records `audit.event` when
   * given. Returns how many were ended.
   */
  async revokeAllForUser(
    userId: string,
    reason: RevocationReason,
    audit?: RevocationAudit,
    now = new Date(),
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      });
      if (audit) await this.events.record(tx, userId, audit.event, audit.client, now);
      return count;
    });
  }
}
