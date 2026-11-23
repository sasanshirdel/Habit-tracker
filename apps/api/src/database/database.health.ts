import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService, errorCode } from './prisma.service.js';

export type DependencyStatus = 'up' | 'down';

/** How long a readiness probe waits for the database before reporting it down. */
export const DB_PING_TIMEOUT_MS = 2_000;

/** Minimal contract the readiness check needs, so it can be unit-tested without a database. */
export interface DatabasePinger {
  $queryRaw<T = unknown>(query: TemplateStringsArray): Promise<T>;
}

/**
 * Database health indicator: a cheap round-trip (`SELECT 1`) bounded by a timeout.
 * Never throws and never returns driver error details (they can leak hostnames/users).
 */
@Injectable()
export class DatabaseHealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);
  /** Overridable in tests; production uses the default. */
  timeoutMs = DB_PING_TIMEOUT_MS;

  // Typed as the narrow interface (explicit token, no reliance on decorator metadata) so unit
  // tests can pass a fake without a database.
  constructor(@Inject(PrismaService) private readonly db: DatabasePinger) {}

  async check(): Promise<DependencyStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DbPingTimeoutError()), this.timeoutMs);
    });
    try {
      await Promise.race([this.db.$queryRaw`SELECT 1`, timeout]);
      return 'up';
    } catch (error) {
      this.logger.warn(`Database readiness check failed (${errorCode(error)}).`);
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}

class DbPingTimeoutError extends Error {
  override readonly name = 'DbPingTimeout';
}
