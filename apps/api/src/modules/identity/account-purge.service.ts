import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/index.js';
import { ACCOUNT_DELETION_POLICY } from './account-deletion.policy.js';

/**
 * Hard deletion after the grace period (backlog P2-10, ADR-0025). Deleting the `users` row erases
 * everything the user owns in one statement: every user-owned table references `users(id)` with
 * `ON DELETE CASCADE` (ADR-0017; an integration test fails for a table that does not). Afterwards
 * the address can be registered again.
 *
 * Batched (bounded lock time) and race-free: each batch deletes only rows that are **still**
 * deleted past the cutoff at delete time, so an account restored a moment earlier survives, and
 * concurrent runs never erase anything twice. Logs counts only.
 */
@Injectable()
export class AccountPurgeService {
  private readonly logger = new Logger('AccountPurge');

  constructor(private readonly prisma: PrismaService) {}

  /** Erases every account deleted at or before `now − grace`. Returns how many were erased. */
  async purgeExpired(
    now = new Date(),
    batchSize: number = ACCOUNT_DELETION_POLICY.purgeBatchSize,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - ACCOUNT_DELETION_POLICY.graceMs);
    let total = 0;
    for (;;) {
      const due = await this.prisma.user.findMany({
        where: { deletedAt: { lte: cutoff } },
        orderBy: { deletedAt: 'asc' },
        take: batchSize,
        select: { id: true },
      });
      if (due.length === 0) break;
      const { count } = await this.prisma.user.deleteMany({
        where: { id: { in: due.map((u) => u.id) }, deletedAt: { lte: cutoff } },
      });
      total += count;
      if (due.length < batchSize) break;
    }
    this.logger.log({ msg: 'account purge', erased: total });
    return total;
  }
}
