import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { createApp } from './app.factory.js';
import type { Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  app.enableCors({ origin: config.get('CORS_ORIGINS', { infer: true }), credentials: true });
  const port = config.get('API_PORT', { infer: true });
  await app.listen(port);
}

void bootstrap();
