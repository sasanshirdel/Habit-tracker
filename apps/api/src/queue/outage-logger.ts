import type { Logger } from '@nestjs/common';
import { errorCode } from '../database/prisma.service.js';

/**
 * Logs a dependency outage once instead of once per reconnect attempt, and logs the recovery.
 * Only error codes are logged — Redis/ioredis messages can contain host names and ports.
 */
export class OutageLogger {
  private down = false;

  constructor(
    private readonly logger: Pick<Logger, 'warn' | 'log'>,
    private readonly what: string,
  ) {}

  error(error: unknown): void {
    if (this.down) return;
    this.down = true;
    this.logger.warn(`${this.what} unavailable (${errorCode(error)}); retrying in the background.`);
  }

  ready(): void {
    if (!this.down) return;
    this.down = false;
    this.logger.log(`${this.what} available again.`);
  }

  get isDown(): boolean {
    return this.down;
  }
}
