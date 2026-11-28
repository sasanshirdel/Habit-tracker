import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateWorkerEnv } from '../config/env.js';
import { DatabaseModule } from '../database/index.js';
import {
  AccountDeletedEmailHandler,
  AccountPurgeHandler,
  IDENTITY_SCHEDULES,
  IdentityJobsModule,
  IdentityRetentionHandler,
  PasswordChangedEmailHandler,
  PasswordResetEmailHandler,
  VerificationEmailHandler,
} from '../modules/identity/index.js';
import { HABIT_SCHEDULES, HabitPurgeHandler, HabitsJobsModule } from '../modules/habits/index.js';
import { QueueModule } from '../queue/queue.module.js';
import { JOB_HANDLERS, type JobHandler } from './job-handler.js';
import { JOB_SCHEDULES, JobScheduleRegistrar } from './job-schedules.service.js';
import { SystemNoopJobHandler } from './system-noop.handler.js';
import { WorkerHost } from './worker-host.service.js';

/**
 * Root module of the worker process (`apps/worker`, backlog P1-03). Reuses the API's platform
 * modules (config, database, queue) — same codebase, separate process (ARCHITECTURE §1). Feature
 * modules add their handlers to `JOB_HANDLERS` and their recurring jobs to `JOB_SCHEDULES`
 * (registered in Redis by `JobScheduleRegistrar`, ADR-0026) as they are built.
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
    // Feature modules' job handlers (P2-04 verification/registration, P2-05 password emails,
    // P2-10 account-deleted email and account purge, ADR-0026 retention clean-up).
    IdentityJobsModule,
    // P3-06: daily purge of deleted habits.
    HabitsJobsModule,
  ],
  providers: [
    SystemNoopJobHandler,
    {
      provide: JOB_HANDLERS,
      useFactory: (
        noop: SystemNoopJobHandler,
        verificationEmail: VerificationEmailHandler,
        passwordResetEmail: PasswordResetEmailHandler,
        passwordChangedEmail: PasswordChangedEmailHandler,
        accountDeletedEmail: AccountDeletedEmailHandler,
        accountPurge: AccountPurgeHandler,
        identityRetention: IdentityRetentionHandler,
        habitPurge: HabitPurgeHandler,
      ): JobHandler[] => [
        noop,
        verificationEmail,
        passwordResetEmail,
        passwordChangedEmail,
        accountDeletedEmail,
        accountPurge,
        identityRetention,
        habitPurge,
      ],
      inject: [
        SystemNoopJobHandler,
        VerificationEmailHandler,
        PasswordResetEmailHandler,
        PasswordChangedEmailHandler,
        AccountDeletedEmailHandler,
        AccountPurgeHandler,
        IdentityRetentionHandler,
        HabitPurgeHandler,
      ],
    },
    // Recurring jobs (ADR-0026): feature modules declare them next to their jobs.
    { provide: JOB_SCHEDULES, useValue: [...IDENTITY_SCHEDULES, ...HABIT_SCHEDULES] },
    JobScheduleRegistrar,
    WorkerHost,
  ],
  exports: [WorkerHost, JobScheduleRegistrar],
})
export class WorkerModule {}
