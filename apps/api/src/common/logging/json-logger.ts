import type { LoggerService, LogLevel } from '@nestjs/common';
import { currentRequestContext } from '../request/request-context.js';
import { currentJobContext } from './log-context.js';
import {
  LOG_LEVELS,
  logSettingsFromEnv,
  type LogFormat,
  type LogLevelName,
  type LogSettings,
} from './log-settings.js';
import { redact, scrubText, serializeError, type ErrorSerializationOptions } from './redact.js';

/** Which process writes the line (`api`, `worker`). */
export type ServiceName = 'api' | 'worker';

export interface JsonLoggerOptions extends LogSettings {
  service: ServiceName;
  /** Where finished lines go (one call per line, newline included). Default: stdout. */
  write?: (line: string) => void;
  /** Clock, for tests. */
  now?: () => Date;
}

const LEVEL_RANK: Record<LogLevelName, number> = Object.fromEntries(
  LOG_LEVELS.map((level, index) => [level, index]),
) as Record<LogLevelName, number>;

const NEST_LEVEL: Record<LogLevel, LogLevelName> = {
  verbose: 'trace',
  debug: 'debug',
  log: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

/** Keys set by the logger itself; fields passed by callers cannot overwrite them. */
const RESERVED = new Set([
  'time',
  'level',
  'service',
  'context',
  'msg',
  'requestId',
  'userId',
  'jobId',
  'jobName',
  'attempt',
]);

const looksLikeStack = (value: string) => /\n\s+at\s/.test(value);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Structured logger for the API and the worker (backlog P1-07, ADR-0010), installed as Nest's
 * logger so every `new Logger(Context)` in the codebase writes through it.
 *
 * Each line is one JSON object: `time`, `level`, `service`, `context`, `msg`, the current
 * `requestId`/`userId` (request scope) or `jobId`/`jobName`/`attempt` (job scope), then the
 * caller's fields. Everything passes through `redact` first. Accepted call shapes (Nest's):
 *
 * - `logger.log('message')`, `logger.warn('message', ...)`
 * - `logger.log({ msg: 'message', field: 1 })` — fields become top-level keys
 * - `logger.error('message', stack)` / `logger.error(error)` / `logger.error({ msg, err })`
 */
export class JsonLogger implements LoggerService {
  private minRank: number;
  private readonly format: LogFormat;
  private readonly service: ServiceName;
  private readonly errorOptions: ErrorSerializationOptions;
  private readonly writeLine: (line: string) => void;
  private readonly now: () => Date;

  constructor(options: JsonLoggerOptions) {
    this.minRank = LEVEL_RANK[options.level];
    this.format = options.format;
    this.service = options.service;
    this.errorOptions = { includeMessages: options.includeErrorMessages };
    this.writeLine = options.write ?? ((line) => void process.stdout.write(line));
    this.now = options.now ?? (() => new Date());
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  /** Nest calls this for `logger: [...]` options; the lowest listed level becomes the minimum. */
  setLogLevels(levels: LogLevel[]): void {
    const ranks = levels.map((level) => LEVEL_RANK[NEST_LEVEL[level]]);
    this.minRank = ranks.length ? Math.min(...ranks) : LEVEL_RANK.fatal + 1;
  }

  isLevelEnabled(level: LogLevelName): boolean {
    return LEVEL_RANK[level] >= this.minRank;
  }

  private write(level: LogLevelName, message: unknown, optionalParams: unknown[]): void {
    if (!this.isLevelEnabled(level)) return;
    try {
      this.writeLine(this.render(this.build(level, message, optionalParams)));
    } catch {
      // Logging must never take the process down (e.g. a closed stdout).
    }
  }

  /** Builds the redacted record for one call. */
  private build(
    level: LogLevelName,
    message: unknown,
    optionalParams: unknown[],
  ): Record<string, unknown> {
    const params = [...optionalParams];
    // Nest appends the logger's context name as the last argument.
    let context: string | undefined;
    const last = params.at(-1);
    if (params.length > 0 && typeof last === 'string' && !looksLikeStack(last)) {
      context = last;
      params.pop();
    }
    // Nest's `Logger.error` pads with `undefined` when no stack was given.
    while (params.length > 0 && params.at(-1) === undefined) params.pop();

    const fields: Record<string, unknown> = {};
    let msg: string;
    if (message instanceof Error) {
      msg = message.name || 'Error';
      fields.err = message;
    } else if (isPlainObject(message)) {
      const { msg: m, message: alt, ...rest } = message;
      msg = typeof m === 'string' ? m : typeof alt === 'string' ? alt : '';
      Object.assign(fields, rest);
    } else {
      msg = typeof message === 'string' ? message : String(message);
    }

    for (const param of params) {
      if (typeof param === 'string' && looksLikeStack(param)) {
        // A stack passed as text: keep frames only, unless messages are allowed (see redact.ts).
        const synthetic = new Error();
        synthetic.name = 'Error';
        synthetic.stack = param;
        fields.stack = serializeError(synthetic, this.errorOptions).stack;
      } else if (param instanceof Error) {
        fields.err = param;
      } else if (isPlainObject(param)) {
        Object.assign(fields, param);
      } else if (param !== undefined) {
        const extra = (fields.extra as unknown[] | undefined) ?? [];
        extra.push(param);
        fields.extra = extra;
      }
    }

    const record: Record<string, unknown> = {
      time: this.now().toISOString(),
      level,
      service: this.service,
    };
    if (context) record.context = context;
    record.msg = scrubText(msg);

    const request = currentRequestContext();
    if (request) {
      record.requestId = request.requestId;
      if (request.userId) record.userId = request.userId;
    }
    const job = currentJobContext();
    if (job) {
      record.jobId = job.jobId;
      record.jobName = job.jobName;
      record.attempt = job.attempt;
    }

    const safeFields = redact(fields, this.errorOptions) as Record<string, unknown>;
    for (const [key, value] of Object.entries(safeFields)) {
      // Callers may supply ids only when no ambient context set them (e.g. the error filter).
      if (RESERVED.has(key) && (key in record || !['requestId', 'userId'].includes(key))) continue;
      record[key] = value;
    }
    return record;
  }

  private render(record: Record<string, unknown>): string {
    if (this.format === 'json') return `${JSON.stringify(record)}\n`;
    const { time, level, service: _service, context, msg, ...rest } = record;
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    const where = context ? ` [${String(context)}]` : '';
    return `${String(time)} ${String(level).toUpperCase().padEnd(5)}${where} ${String(msg)}${extra}\n`;
  }
}

/** The process logger, configured from `LOG_LEVEL`, `LOG_FORMAT` and `NODE_ENV`. */
export function createLogger(
  service: ServiceName,
  env: Record<string, string | undefined> = process.env,
): JsonLogger {
  return new JsonLogger({ service, ...logSettingsFromEnv(env) });
}
