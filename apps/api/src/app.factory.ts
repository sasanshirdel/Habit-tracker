import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { requestIdMiddleware } from './common/request/request-id.middleware.js';

export const API_PREFIX = 'api/v1';
/** JSON body size limit; larger bodies → 413 `PAYLOAD_TOO_LARGE`. */
export const JSON_BODY_LIMIT = '100kb';

/**
 * Applies the global HTTP conventions (backlog P1-05) to an app. Shared by `createApp` and by
 * tests that mount extra controllers, so both behave identically:
 * 1. request id first (so every later step, including body-parse errors and 404s, has one);
 * 2. JSON body parser (registered after it — Nest's built-in parser is disabled for this);
 * 3. global exception filter → `{ error: { code, message, details?, requestId } }`.
 * Validation is per parameter with `ZodValidationPipe` (ADR-0009).
 */
export function configureApp(app: NestExpressApplication): void {
  // Do not advertise the server stack. Full security headers (helmet) land with P1-08.
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
}

/** Builds the app with the global settings shared by runtime and tests. */
export async function createApp(
  rootModule: Parameters<typeof NestFactory.create>[0] = AppModule,
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(rootModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false,
  });
  configureApp(app);
  return app;
}
