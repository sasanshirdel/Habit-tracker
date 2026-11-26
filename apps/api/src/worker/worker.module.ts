import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateWorkerEnv } from '../config/env.js';
import { DatabaseModule } from '../database/index.js';
import { IdentityJobsModule, VerificationEmailHandler } from '../modules/identity/index.js';
import { QueueModule } from '../queue/queue.module.js';
import { JOB_HANDLERS, type JobHandler } from './job-handler.js';
import { SystemNoopJobHandler } from './system-noop.handler.js';
import { WorkerHost } from './worker-host.service.js';

/**
 * Root module of the worker process (`apps/worker`, backlog P1-03). Reuses the API's platform
 * modules (config, database, queue) — same codebase, separate process (ARCHITECTURE §1). Feature
 * modules add their handlers to `JOB_HANDLERS` as they are built.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '../../.env'],
      validate: validateWorkerEnv,
    }),
    DatabaseModule,
    QueueModule,
    // Feature modules' job handlers (P2-04: verification and registration emails).
    IdentityJobsModule,
  ],
  providers: [
    SystemNoopJobHandler,
    {
      provide: JOB_HANDLERS,
      useFactory: (
        noop: SystemNoopJobHandler,
        verificationEmail: VerificationEmailHandler,
      ): JobHandler[] => [noop, verificationEmail],
      inject: [SystemNoopJobHandler, VerificationEmailHandler],
    },
    WorkerHost,
  ],
  exports: [WorkerHost],
})
export class WorkerModule {}
