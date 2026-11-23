import type { INestApplication, LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { accessLogMiddleware } from './common/logging/access-log.middleware.js';
import { createLogger } from './common/logging/json-logger.js';
import { requestIdMiddleware } from './common/request/request-id.middleware.js';
import { corsDelegate, securityHeadersMiddleware } from './common/security/security-headers.js';
import type { Env } from './config/env.js';

export const API_PREFIX = 'api/v1';
/** JSON body size limit; larger bodies → 413 `PAYLOAD_TOO_LARGE`. */
export const JSON_BODY_LIMIT = '100kb';

/**
 * Applies the global HTTP conventions (backlog P1-05) to an app. Shared by `createApp` and by
 * tests that mount extra controllers, so both behave identically:
 * 1. security headers (P1-08) on every response, including errors, 404s and 429s;
 * 2. request id (so every later step, including body-parse errors and 404s, has one);
 * 3. access log (P1-07): one structured line per request, inside the request context;
 * 4. CORS (P1-08): exact allow-list from `CORS_ORIGINS`;
 * 5. JSON body parser (registered after them — Nest's built-in parser is disabled for this);
 * 6. global exception filter → `{ error: { code, message, details?, requestId } }`.
 * Validation is per parameter with `ZodValidationPipe` (ADR-0009); rate limiting is a global
 * guard (`RateLimitModule`, ADR-0011) and so runs after routing, before handlers.
 * The root module must provide `ConfigService` (AppModule does).
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  // Do not advertise the server stack.
  app.disable('x-powered-by');
  // Client address for rate limiting: trust exactly TRUST_PROXY hops of X-Forwarded-For (0: none).
  const trustProxy = config.get('TRUST_PROXY', { infer: true });
  app.set('trust proxy', trustProxy === 0 ? false : trustProxy);
  app.use(securityHeadersMiddleware);
  app.use(requestIdMiddleware);
  app.use(accessLogMiddleware);
  app.enableCors(corsDelegate(config.get('CORS_ORIGINS', { infer: true })));
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
