import { z } from 'zod';

/** Log levels, lowest first. Nest's `verbose` maps to `trace`, `log` to `info`. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ['json', 'pretty'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

/**
 * Logging variables, part of every process's environment schema (`config/env.ts`), so an invalid
 * value stops startup like any other misconfiguration.
 * - `LOG_LEVEL`: lowest level written. Default by `NODE_ENV`: `debug` in development, else `info`.
 * - `LOG_FORMAT`: `json` (default; one object per line, what log collectors ingest) or `pretty`
 *   (human-readable, local development only — still redacted).
 */
export const logEnvSchema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  LOG_FORMAT: z.enum(LOG_FORMATS).default('json'),
});

export interface LogSettings {
  level: LogLevelName;
  format: LogFormat;
  /** Error messages are logged only with `NODE_ENV=development` (see `serializeError`). */
  includeErrorMessages: boolean;
}

/**
 * Resolves logging settings from raw environment variables. Used before configuration validation
 * (the logger must exist to report a configuration error), so invalid values fall back to the
 * defaults here — the environment schema then rejects them and startup fails with that message.
 */
export function logSettingsFromEnv(raw: Record<string, string | undefined>): LogSettings {
  const nodeEnv = raw.NODE_ENV ?? 'development';
  const parsed = logEnvSchema.safeParse({ LOG_LEVEL: raw.LOG_LEVEL, LOG_FORMAT: raw.LOG_FORMAT });
  const values = parsed.success
    ? parsed.data
    : { LOG_LEVEL: undefined, LOG_FORMAT: 'json' as const };
  const isDevelopment = nodeEnv === 'development';
  return {
    level: values.LOG_LEVEL ?? (isDevelopment ? 'debug' : 'info'),
    format: values.LOG_FORMAT,
    // Only when development is set explicitly: an unset NODE_ENV must not leak messages.
    includeErrorMessages: raw.NODE_ENV === 'development',
  };
}
