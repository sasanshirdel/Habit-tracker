import { Injectable } from '@nestjs/common';
import {
  USER_DATA_EXPORT_FORMAT,
  USER_DATA_EXPORT_VERSION,
  type UserDataExport,
} from '@habit/shared-types';
import { PrismaService } from '../database/index.js';
import { UserDataExportRegistry } from './user-data-export.registry.js';

/** Upper bound for building one export; a snapshot transaction must not stay open for long. */
export const USER_DATA_EXPORT_TIMEOUT_MS = 15_000;

/**
 * Builds the signed-in user's data export (backlog P2-10, ADR-0025): every registered module's
 * section, read in **one** read-only `REPEATABLE READ` transaction so rows from different tables
 * belong to the same moment. Synchronous by design while the data is small (see ADR-0025 for when
 * this moves to a worker job with a short-lived download). The result is returned to the caller
 * only — never logged, cached or stored.
 */
@Injectable()
export class UserDataExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: UserDataExportRegistry,
  ) {}

  async exportFor(userId: string, now = new Date()): Promise<UserDataExport> {
    const contributors = this.registry.list();
    const sections = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const collected: Record<string, unknown> = {};
        for (const contributor of contributors) {
          collected[contributor.section] = await contributor.collect(tx, userId);
        }
        return collected;
      },
      { isolationLevel: 'RepeatableRead', timeout: USER_DATA_EXPORT_TIMEOUT_MS },
    );
    return {
      format: USER_DATA_EXPORT_FORMAT,
      version: USER_DATA_EXPORT_VERSION,
      exportedAt: now.toISOString(),
      sections,
    };
  }
}
