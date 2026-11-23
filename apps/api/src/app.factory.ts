import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

export const API_PREFIX = 'api/v1';

/** Builds the app with the global settings shared by runtime and tests. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  // Do not advertise the server stack. Full security headers (helmet) land in Phase 1.
  app.disable('x-powered-by');
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  return app;
}
