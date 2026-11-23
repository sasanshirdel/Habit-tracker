import type { INestApplication, LoggerService } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { accessLogMiddleware } from './common/logging/access-log.middleware.js';
import { createLogger } from './common/logging/json-logger.js';
import { requestIdMiddleware } from './common/request/request-id.middleware.js';

export const API_PREFIX = 'api/v1';
/** JSON body size limit; larger bodies → 413 `PAYLOAD_TOO_LARGE`. */
export const JSON_BODY_LIMIT = '100kb';

/**
 * Applies the global HTTP conventions (backlog P1-05) to an app. Shared by `createApp` and by
 * tests that mount extra controllers, so both behave identically:
 * 1. request id first (so every later step, including body-parse errors and 404s, has one);
 * 2. access log (P1-07): one structured line per request, inside the request context;
 * 3. JSON body parser (registered after them — Nest's built-in parser is disabled for this);
 * 4. global exception filter → `{ error: { code, message, details?, requestId } }`.
 * Validation is per parameter with `ZodValidationPipe` (ADR-0009).
 */
export function configureApp(app: NestExpressApplication): void {
  // Do not advertise the server stack. Full security headers (helmet) land with P1-08.
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(accessLogMiddleware);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
}

export interface CreateAppOptions {
  /** Defaults to the structured JSON logger configured from the environment (P1-07). */
  logger?: LoggerService;
}

/** Builds the app with the global settings shared by runtime and tests. */
export async function createApp(
  rootModule: Parameters<typeof NestFactory.create>[0] = AppModule,
  options: CreateAppOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(rootModule, {
    // Installed as Nest's logger, so every `new Logger(Context)` writes structured, redacted JSON.
    logger: options.logger ?? createLogger('api'),
    bodyParser: false,
  });
  configureApp(app);
  return app;
}
