import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/** Upper bound for opening a new pool connection, so a dead database fails fast instead of hanging. */
export const DB_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * The single Prisma client of the API process, backed by the `pg` driver adapter (Prisma 7).
 *
 * - The connection string comes only from validated env (`DATABASE_URL`); it is never logged.
 * - Only Prisma `warn` events are logged — never `query` (parameters) nor Prisma's own `error`
 *   lines (they can echo invocation arguments), because both can contain personal data
 *   (PRD §10, SECURITY.md).
 * - Startup does not require the database: a DB outage makes the instance *not ready*
 *   (`/api/v1/health/ready` → 503) rather than crash-looping it; liveness stays green.
 *
 * Modules must not inject this directly across module boundaries for another module's tables
 * (ADR-0006); each module wraps its own data access behind its exported service.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      }),
      // Only client warnings are subscribed to. `query` events carry parameters, and Prisma's
      // `error` log lines can embed the failing invocation's arguments (possible personal data);
      // errors still reach the caller as exceptions and are logged by the API's error handling
      // (structured, redacted logging arrives with backlog P1-07).
      log: [{ level: 'warn', emit: 'event' }],
    });
    // `extends PrismaClient` erases the log-level generic, so re-type `this` for `$on`.
    (this as unknown as PrismaClient<'warn'>).$on('warn', (event) =>
      this.logger.warn(`Prisma warning: ${event.message}`),
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (error) {
      // Do not include the error object: driver messages can echo host/user details.
      this.logger.warn(
        `Database not reachable at startup (${errorCode(error)}); readiness will report it.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** Extracts a non-sensitive error code (e.g. ECONNREFUSED, 28P01) for logs. */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unknown';
}
