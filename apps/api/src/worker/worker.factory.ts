import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerHost, type DrainResult } from './worker-host.service.js';
import { WorkerModule } from './worker.module.js';

/** Boots the worker: a Nest application context (no HTTP server) whose consumers start at once. */
export async function createWorkerContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
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
