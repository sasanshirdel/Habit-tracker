import type { INestApplicationContext, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLogger } from '../common/logging/json-logger.js';
import { WorkerHost, type DrainResult } from './worker-host.service.js';
import { WorkerModule } from './worker.module.js';

/** Boots the worker: a Nest application context (no HTTP server) whose consumers start at once. */
export async function createWorkerContext(
  logger: LoggerService = createLogger('worker'),
): Promise<INestApplicationContext> {
  // Structured, redacted JSON logs (P1-07), the same format as the API.
  return NestFactory.createApplicationContext(WorkerModule, { logger });
}

/**
 * Graceful shutdown in the right order: drain the consumers first (in-flight jobs finish while the
 * database and queues are still open), then close the context (Prisma, producer queues, Redis).
 */
export async function shutdownWorker(context: INestApplicationContext): Promise<DrainResult> {
  const result = await context.get(WorkerHost).drain();
  await context.close();
  return result;
}
