import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { DataExportModule } from './data-export/index.js';
import { DatabaseModule } from './database/index.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './modules/identity/index.js';
import { QueueModule } from './queue/queue.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Local development: `.env` next to the API, else the repository-root `.env` created from
      // `.env.example`. Real environment variables always take precedence over files.
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),
    DatabaseModule,
    QueueModule,
    // Registers the global rate-limit guard. Keep it before modules that add authentication
    // guards (P2-03): global guards run in registration order, and the limiter must run first.
    RateLimitModule,
    HealthModule,
    // Global registry feature modules contribute their part of the user's data export to (P2-10).
    DataExportModule,
    IdentityModule,
  ],
})
export class AppModule {}
