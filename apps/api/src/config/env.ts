import { z } from 'zod';
import { logEnvSchema } from '../common/logging/log-settings.js';
import { SAFE_MESSAGE } from '../common/logging/redact.js';

/**
 * Environment schemas. Each process refuses to start when its configuration is invalid
 * (fail fast, never fall back to insecure defaults). Secret values are never echoed in
 * validation errors — only variable names and the problem.
 *
 * - `baseEnvSchema`: what every process built from this codebase needs (API and worker).
 * - `envSchema`: the HTTP API (`apps/api`).
 * - `workerEnvSchema`: the background worker (`apps/worker`, backlog P1-03).
 */
export const baseEnvSchema = logEnvSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Required: the API cannot serve data without PostgreSQL (backlog P1-01). No default, so a
  // missing value fails fast instead of silently pointing at some local database.
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Required since P1-03: queues (BullMQ) need Redis. Same fail-fast rule as DATABASE_URL.
  // `rediss://` enables TLS for managed Redis.
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // Namespace for every BullMQ key (`<prefix>:<queue>:…`), so queues can share a Redis with
  // other data and integration tests can isolate a run. Letters, digits, `:`, `_`, `-`; no
  // leading/trailing `:` (BullMQ adds the separator).
  QUEUE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)*$/, 'letters, digits, "_", "-" separated by ":"')
    .max(64)
    .default('habit:q'),
});

export const envSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url())),
});

export const workerEnvSchema = baseEnvSchema.extend({
  // Jobs processed in parallel per queue by one worker process.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  // How long a shutdown waits for in-flight jobs before disconnecting. Keep it below the
  // orchestrator's termination grace period; jobs cut off are recovered as stalled and retried.
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(25_000),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type Env = z.infer<typeof envSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Startup configuration error. Its message lists variable names and problems only (never values),
 * so it is marked safe for logs (`SAFE_MESSAGE`) and stays readable in production logs.
 */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  readonly [SAFE_MESSAGE] = true;
}

function validateWith<S extends z.ZodType>(schema: S, raw: Record<string, unknown>): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvValidationError(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

/** Validates only the shared settings (e.g. a producer-only context for scripts and tests). */
export function validateBaseEnv(raw: Record<string, unknown>): BaseEnv {
  return validateWith(baseEnvSchema, raw);
}

/** Validates the HTTP API's environment (used by `ConfigModule` in `AppModule`). */
export function validateEnv(raw: Record<string, unknown>): Env {
  return validateWith(envSchema, raw);
}

/** Validates the worker's environment (used by `ConfigModule` in `WorkerModule`). */
export function validateWorkerEnv(raw: Record<string, unknown>): WorkerEnv {
  return validateWith(workerEnvSchema, raw);
}
