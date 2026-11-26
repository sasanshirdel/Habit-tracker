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
  // Rate limiting (backlog P1-08, ADR-0011). Counters live in Redis under this namespace.
  // `RATE_LIMIT_ENABLED=false` switches the limiter off entirely — local load tests only; never
  // in staging/production.
  RATE_LIMIT_ENABLED: z.stringbool().default(true),
  RATE_LIMIT_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)*$/, 'letters, digits, "_", "-" separated by ":"')
    .max(64)
    .default('habit:rl'),
  // Number of reverse proxies in front of the API whose `X-Forwarded-For` entry is trusted for
  // the client address (Express `trust proxy`). 0 (default) trusts none: the socket address is
  // the client. Set it to the real hop count behind a load balancer, or every client shares the
  // proxy's address — and its rate limit; never higher, or clients can spoof their address.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  // OpenAPI document at `/api/docs/openapi.json` (backlog P1-06, ADR-0012). Unset: served unless
  // NODE_ENV=production. Production (and staging, which runs with NODE_ENV=production) serves it
  // only with an explicit `API_DOCS_ENABLED=true` — a deliberate choice that is logged as a warning.
  API_DOCS_ENABLED: z.stringbool().optional(),
});

/** Whether the API serves its OpenAPI document (see `API_DOCS_ENABLED`). */
export function apiDocsEnabled(env: Pick<Env, 'API_DOCS_ENABLED' | 'NODE_ENV'>): boolean {
  return env.API_DOCS_ENABLED ?? env.NODE_ENV !== 'production';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// "Name <local@domain>" or a bare "local@domain"; no line breaks (header injection), ≤ 254.
const MAIL_FROM = /^(?:[^\r\n<>"]{1,64} )?<?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.?[A-Za-z0-9-]*>?$/;

/**
 * Transactional email (backlog P2-04, ADR-0021) — read by the worker, which sends every email.
 * Only development/test transports exist; a real provider is an owner decision.
 */
export const mailEnvShape = {
  // `log` (default): nothing is delivered, one redacted line per message. `outbox`: each message
  // is written as a JSON file into MAIL_OUTBOX_DIR (local development and the browser suite only —
  // the files contain live single-use links).
  MAIL_TRANSPORT: z.enum(['log', 'outbox']).default('log'),
  MAIL_OUTBOX_DIR: z.string().min(1).max(4096).optional(),
  // Sender of every message. Placeholder domain until the product name/domain is decided
  // (ROADMAP "Outstanding decisions" #2).
  MAIL_FROM: z
    .string()
    .max(254)
    .regex(MAIL_FROM, 'an address, optionally with a display name: "Name <a@b.example>"')
    .default('Habit Tracker <no-reply@localhost>'),
  // Origin of the web app that emailed links point to (`<origin>/<locale>/auth/…`). Must be
  // https, except http on a loopback host for local development and tests.
  WEB_APP_URL: z
    .url({ protocol: /^https?$/ })
    .default('http://localhost:3000')
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' || LOOPBACK_HOSTS.has(url.hostname);
    }, 'must be an https URL (http only on localhost/127.0.0.1)')
    .refine((value) => {
      const url = new URL(value);
      return url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
    }, 'must be an origin only (no path, query, fragment or credentials)')
    .transform((value) => new URL(value).origin),
};

export const mailEnvSchema = z.object(mailEnvShape);
export type MailEnv = z.infer<typeof mailEnvSchema>;

export const workerEnvSchema = baseEnvSchema
  .extend({
    // Jobs processed in parallel per queue by one worker process.
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    // How long a shutdown waits for in-flight jobs before disconnecting. Keep it below the
    // orchestrator's termination grace period; jobs cut off are recovered as stalled and retried.
    WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(25_000),
    ...mailEnvShape,
  })
  .superRefine((env, ctx) => {
    if (env.MAIL_TRANSPORT === 'outbox' && !env.MAIL_OUTBOX_DIR) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_OUTBOX_DIR'],
        message: 'required when MAIL_TRANSPORT=outbox',
      });
    }
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
