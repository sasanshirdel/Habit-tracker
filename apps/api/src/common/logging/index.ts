// Structured logging (backlog P1-07, ADR-0010): JSON lines, request/job context, redaction.
export {
  accessLogFields,
  accessLogMiddleware,
  MAX_LOGGED_PATH,
  type AccessLogFields,
} from './access-log.middleware.js';
export {
  JsonLogger,
  createLogger,
  type JsonLoggerOptions,
  type ServiceName,
} from './json-logger.js';
export { currentJobContext, runWithJobContext, type JobLogContext } from './log-context.js';
export {
  LOG_FORMATS,
  LOG_LEVELS,
  logEnvSchema,
  logSettingsFromEnv,
  type LogFormat,
  type LogLevelName,
  type LogSettings,
} from './log-settings.js';
export {
  REDACTED,
  SAFE_MESSAGE,
  isSensitiveKey,
  redact,
  scrubText,
  serializeError,
  type ErrorSerializationOptions,
  type SerializedError,
} from './redact.js';
