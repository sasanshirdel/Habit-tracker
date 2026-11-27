import { Injectable } from '@nestjs/common';
import {
  SECURITY_EVENT_RETENTION_DAYS,
  type ClientDescription,
  type SecurityEvent,
  type SecurityEventList,
  type SecurityEventType,
} from '@habit/shared-types';
import { decodeCursor, paginate } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/index.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { clientColumns, clientFromColumns } from './client-description.js';
import { idCursorSchema } from './account.schemas.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SECURITY_EVENT_RETENTION_MS = SECURITY_EVENT_RETENTION_DAYS * DAY_MS;

/** A Prisma client or the transaction client of `$transaction(async (tx) => …)`. */
export type IdentityDb = Prisma.TransactionClient;

/**
 * The per-account security event log (backlog P2-08, ADR-0023), table `user_security_events`.
 *
 * - **Written with the change it records:** callers pass their transaction client, so an event
 *   exists exactly when the sign-in, revocation, password reset or verification committed.
 * - **Minimal:** event type, time and the coarse client description — no IP address, user agent,
 *   email, token or free text.
 * - **Retention ({@link SECURITY_EVENT_RETENTION_DAYS} days, interim):** every write purges the
 *   account's events older than the window (indexed on `(user_id, created_at)`), and reads never
 *   return them. Accounts that stay inactive keep old rows until a global clean-up job exists
 *   (scheduled jobs are not built yet) or the account is deleted (cascade).
 */
@Injectable()
export class SecurityEventService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    db: IdentityDb,
    userId: string,
    type: SecurityEventType,
    client: ClientDescription,
    now = new Date(),
  ): Promise<void> {
    await db.userSecurityEvent.create({
      data: { userId, type, createdAt: now, ...clientColumns(client) },
      select: { id: true },
    });
    await db.userSecurityEvent.deleteMany({
      where: { userId, createdAt: { lt: new Date(now.getTime() - SECURITY_EVENT_RETENTION_MS) } },
    });
  }

  /** The account's events within the retention window, newest first (keyset on the UUIDv7 id). */
  async list(
    userId: string,
    page: { limit: number; cursor?: string | undefined },
    now = new Date(),
  ): Promise<SecurityEventList> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor, idCursorSchema);
    const rows = await this.prisma.userSecurityEvent.findMany({
      where: {
        userId,
        createdAt: { gte: new Date(now.getTime() - SECURITY_EVENT_RETENTION_MS) },
        ...(after ? { id: { lt: after.id } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      select: {
        id: true,
        type: true,
        createdAt: true,
        clientBrowser: true,
        clientOs: true,
        clientDevice: true,
      },
    });
    const events: SecurityEvent[] = rows.map((row) => ({
      id: row.id,
      type: row.type,
      occurredAt: row.createdAt.toISOString(),
      client: clientFromColumns(row),
    }));
    return paginate(events, page.limit, (last) => ({ id: last.id }));
  }
}
