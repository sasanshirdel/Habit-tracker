import { Global, Module } from '@nestjs/common';
import { DatabaseHealthIndicator } from './database.health.js';
import { PrismaService } from './prisma.service.js';

/**
 * Platform database module (backlog P1-01). Global so feature modules can inject PrismaService
 * inside their own repositories without re-importing it; ownership rules still apply (ADR-0006).
 */
@Global()
@Module({
  providers: [PrismaService, DatabaseHealthIndicator],
  exports: [PrismaService, DatabaseHealthIndicator],
})
export class DatabaseModule {}
