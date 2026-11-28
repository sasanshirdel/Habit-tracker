/**
 * Log redaction (backlog P1-07, PRD §10, SECURITY.md): nothing secret or sensitive may reach a log
 * line. Two layers, applied by `JsonLogger` to everything it writes:
 *
 * 1. **By key, at any depth** — a field whose name looks sensitive is replaced with `[REDACTED]`
 *    whatever its value (passwords, secrets, tokens, authorization, cookies, sessions, API keys,
 *    payment data, journal/free-text content, AI prompts, email/phone).
 * 2. **By pattern, inside every string** (messages included) — URL credentials, `Bearer`/`Basic`
 *    credentials, JWTs and `password=`/`token=` pairs are masked.
 *
 * Redaction is a safety net, not permission: code still must not log payloads, bodies or user
 * content on purpose. Pure functions, unit-tested in `logging.test.ts`.
 */

export const REDACTED = '[REDACTED]';

/** Normalised key fragments (lowercase, letters/digits only) that mark a field as sensitive. */
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'credential',
  'cardnumber',
  'cvv',
  'cvc',
  'iban',
  'journal',
  'signature',
  'recoverycode',
  'databaseurl',
  'redisurl',
  'connectionstring',
  // Personal details a user typed (P2-07): `displayName`, `display_name`, `firstName`…
  'displayname',
  'fullname',
  'firstname',
  'lastname',
] as const;

/** Normalised keys that are sensitive only as a whole word (too short or too common as parts). */
const SENSITIVE_KEYS = new Set([
  'auth',
  'pan',
  'pin',
  'otp',
  'totp',
  'sid',
  'session',
  'sessionid',
  'body',
  'content',
  'text',
  'note',
  'notes',
  'prompt',
  'completion',
  'email',
  'phone',
  'phonenumber',
  'mood',
  'energy',
  'stress',
]);

/**
 * Keys that contain a sensitive part but carry no secret, e.g. AI usage counters
 * (`tokenCount`, `inputTokens`) or token metadata (`tokenType`, `tokenExpiresAt`).
 */
const SAFE_TOKEN_KEY =
  /^(input|output|prompt|completion|total|max)?tokens?(count|total|limit|used|usage|type|ttl|expiresat)?$/;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a field with this name must never be logged in clear. */
export function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  if (k === '') return false;
  if (SENSITIVE_KEYS.has(k)) return true;
  if (k.includes('token') && SAFE_TOKEN_KEY.test(k) && k !== 'token' && k !== 'tokens') {
    return false;
  }
  return SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}

/** Longest string kept in a log field; longer values are cut (also bounds log volume). */
export const MAX_STRING_LENGTH = 2_048;
/** Deepest nesting kept; deeper values become `[Truncated]`. */
export const MAX_DEPTH = 6;
/** Most array items kept. */
export const MAX_ARRAY_ITEMS = 50;

const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // scheme://user:password@host → scheme://[REDACTED]@host (also scheme://:password@host)
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, `$1${REDACTED}@`],
  // Authorization header values
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // JWT / JWS (header.payload.signature, base64url)
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // key=value pairs (query strings, form bodies, DSNs)
  [
    /\b((?:[a-z0-9_-]*?)(?:password|passwd|secret|token|api[_-]?key|session|sid|code))=([^&\s;,]+)/gi,
    `$1=${REDACTED}`,
  ],
];

/** Masks credentials that appear inside free text, and bounds its length. */
export function scrubText(text: string): string {
  let out =
    text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…[truncated]` : text;
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export interface SerializedError {
  name: string;
  code?: string;
  message?: string;
  stack?: string;
  cause?: SerializedError | string;
}

/**
 * Errors whose message is written by us and known to contain no secrets or user input (e.g. the
 * environment validation error, which lists variable names only) set this property to `true`.
 */
export const SAFE_MESSAGE = Symbol.for('habit.log.safeMessage');

export interface ErrorSerializationOptions {
  /**
   * Include error messages. Off outside development: messages from drivers, parsers and libraries
   * can echo user input, SQL parameters or connection details. Stack frames are always kept.
   */
  includeMessages: boolean;
}

function stackFrames(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const frames = stack
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, 25);
  return frames.length ? frames.join('\n') : undefined;
}

function hasSafeMessage(error: Error): boolean {
  return (error as unknown as Record<symbol, unknown>)[SAFE_MESSAGE] === true;
}

/** Turns an error into a loggable object: name, code, stack frames; message only when allowed. */
export function serializeError(
  error: Error,
  options: ErrorSerializationOptions,
  depth = 0,
): SerializedError {
  const out: SerializedError = { name: error.name || 'Error' };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out.code = String(code);
  const withMessage = options.includeMessages || hasSafeMessage(error);
  if (withMessage && error.message) out.message = scrubText(error.message);
  const stack = withMessage ? error.stack && scrubText(error.stack) : stackFrames(error.stack);
  if (stack) out.stack = stack;
  if (error.cause !== undefined && depth < 3) {
    out.cause =
      error.cause instanceof Error
        ? serializeError(error.cause, options, depth + 1)
        : typeof error.cause;
  }
  return out;
}

/**
 * Deep-copies a value into something safe to serialise: sensitive keys masked, strings scrubbed,
 * errors serialised, depth/size bounded, cycles broken, binary and functions summarised.
 */
export function redact(value: unknown, options: ErrorSerializationOptions): unknown {
  const ancestors = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    switch (typeof v) {
      case 'string':
        return scrubText(v);
      case 'number':
      case 'boolean':
        return v;
      case 'bigint':
        return v.toString();
      case 'symbol':
        return v.toString();
      case 'function':
        return '[Function]';
    }
    const obj = v as object;
    if (obj instanceof Date)
      return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
    if (obj instanceof Error) return serializeError(obj, options);
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
      return `[Binary ${obj.byteLength} bytes]`;
    }
    if (obj instanceof Map || obj instanceof Set)
      return `[${obj.constructor.name} size=${obj.size}]`;
    if (depth >= MAX_DEPTH) return '[Truncated]';
    if (ancestors.has(obj)) return '[Circular]';
    ancestors.add(obj);
    try {
      if (Array.isArray(obj)) {
        const items = obj.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, depth + 1));
        if (obj.length > MAX_ARRAY_ITEMS) items.push(`[+${obj.length - MAX_ARRAY_ITEMS} more]`);
        return items;
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(obj)) {
        if (typeof child === 'function') continue;
        out[key] = isSensitiveKey(key) ? REDACTED : walk(child, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(obj);
    }
  };

  return walk(value, 0);
}
