import { Module, type INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { validateBaseEnv } from '../config/env.js';
import { QueueModule } from './queue.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '../../.env'],
      validate: validateBaseEnv,
    }),
    QueueModule,
  ],
})
class QueueProducerContextModule {}

/**
 * A producer-only application context (no HTTP server, no consumers): for scripts and for tests
 * that drive a separately running worker process. Close it with `context.close()`.
 */
export async function createQueueProducerContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(QueueProducerContextModule, {
    logger: ['error', 'warn'],
  });
}
