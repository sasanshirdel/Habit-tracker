# ADR-0010: Structured logging and redaction

- **Status:** Accepted (Phase 1, backlog P1-07)
- **Date:** 2026-11-24

## Context

PRD §10 requires structured logging and forbids logging sensitive user content, passwords, access
tokens or payment secrets; SECURITY.md lists what logs must redact (passwords, tokens, cookies,
authorization headers, payment data, journal content). ARCHITECTURE §Observability asks Phase 1 for
the logging/request-ID foundation; P1-05 (ADR-0009) already gives every request an id in an
`AsyncLocalStorage` context. Until now the API and the worker used Nest's default text logger: no
request id on lines (only inside some messages), no redaction, and the exception filter logged
full stacks whose first line repeats the error message — which can contain user input or driver
details (e.g. a unique-constraint message echoes the duplicated email).

## Decision

### One logger, written by us, installed as Nest's logger

- `JsonLogger` (`apps/api/src/common/logging/`) implements Nest's `LoggerService` and is passed to
  `NestFactory.create` (API, `createApp`) and `NestFactory.createApplicationContext` (worker,
  `createWorkerContext`). Every existing `new Logger(Context)` call therefore writes through it;
  modules keep using Nest's `Logger` and need no new API.
- Output: **one JSON object per line on stdout** (12-factor; the platform's collector ships it):
  `time` (ISO 8601 UTC), `level` (`trace|debug|info|warn|error|fatal`), `service`
  (`api|worker`), `context`, `msg`, then context ids, then the caller's fields. Callers can log a
  plain object — `logger.log({ msg: 'x', habitId })` — and its fields become top-level keys;
  logger-owned keys cannot be overwritten by fields.
- **Context ids, automatically:** inside a request, `requestId` (same value as the `x-request-id`
  header) and `userId` once known — `setRequestUserId(id)` is the hook the authentication guard
  (P2-03) calls; inside a job, `jobId`, `jobName`, `attempt` (the job processor runs handlers in
  a job log context). Payloads are never part of the context.
- **Access log:** `accessLogMiddleware` (registered right after `requestIdMiddleware`) writes one
  line per request: method, matched **route pattern** (`/api/v1/habits/:id`, not the raw path —
  so ids or tokens in paths never land in logs and latency can be aggregated per route), status,
  duration, `aborted` when the client went away. The raw path (no query string, max 200 chars) is
  logged only when no specific route matched (404s). Headers, cookies, query strings and bodies are
  never logged. Health probes log at `debug`; 5xx at `warn` (the error itself is logged once by
  the exception filter).
- **Levels and format by environment:** `LOG_LEVEL` (`trace…fatal`), default `debug` in
  development and `info` otherwise; `LOG_FORMAT=json` (default) or `pretty` for local reading.
  Both are part of the validated environment schema.

### Redaction is mandatory and happens in the logger

Everything written goes through `redact()` / `scrubText()` (`redact.ts`), whatever the caller did:

1. **By key, at any depth:** a field whose normalised name contains `password`, `secret`, `token`,
   `authorization`, `cookie`, `apikey`, `privatekey`, `credential`, `cardnumber`, `cvv`, `cvc`,
   `iban`, `journal`, `signature`, `recoverycode`, `databaseurl`, `redisurl`, `connectionstring`
   — or is exactly `auth`, `pan`, `pin`, `otp`, `totp`, `sid`, `session`, `sessionid`, `body`,
   `content`, `text`, `note(s)`, `prompt`, `completion`, `email`, `phone(number)`, `mood`,
   `energy`, `stress` — is replaced by `[REDACTED]`. Token usage counters (`tokenCount`,
   `inputTokens`, …) are allowed so AI usage can be logged (Phase 7).
2. **By pattern, in every string, messages included:** URL credentials (`scheme://user:pass@`),
   `Bearer`/`Basic` credentials, JWTs, and `password=`/`token=`/`secret=`/`api_key=`/`session=`/
   `code=` pairs are masked.
3. **Bounds:** strings cut at 2 048 chars, depth 6, arrays 50 items, cycles broken, binary
   summarised.
4. **Errors:** name, `code`, stack **frames** and causes are logged; the **message is dropped
   unless `NODE_ENV=development`** (set explicitly), because messages from drivers and libraries
   echo input. Errors that we author with a known-safe message carry the `SAFE_MESSAGE` marker —
   `EnvValidationError` (variable names only) is the first — and keep it in every environment.

Redaction is a safety net, not a licence: code must still never log bodies, payloads or user
content on purpose (SECURITY.md). Adding a sensitive field name to the list is a normal code change
with a unit test.

### Also changed

- The exception filter logs unexpected errors as one structured line
  (`code`, `status`, `requestId`, `err`), not a text message plus a raw stack.
- Deliberate 5xx states — `NOT_READY`, `SERVICE_UNAVAILABLE`, `QUEUE_UNAVAILABLE` — are no longer
  logged as unexpected errors (a failing readiness probe used to write an error with a stack every
  few seconds); the access line still records the 503.

## Alternatives considered

Checked against the npm registry on 2026-11-24 (UTC+03:30) with `npm view`:

- **pino 10.4.0** (last modified 2026-10-02; 11 runtime dependencies incl. `sonic-boom`,
  `thread-stream`, `@pinojs/redact`) **+ nestjs-pino 5.3.2** (2026-11-19; peers `pino ^10`,
  `pino-http ^11`, Nest `^11.0.8 || ^12.0.2`). Healthy and the most common choice, and the backlog
  suggested it. Not taken: pino's redaction is **path-based** (`req.headers.authorization`,
  `*.password` one level deep), while we need key-name matching at any depth plus pattern scrubbing
  inside strings — we would write our own redactor either way. `pino-http` logs request headers by
  default (needs custom serializers to be safe) and brings its own request-id handling, duplicating
  ADR-0009's `AsyncLocalStorage` context. What remains — JSON serialisation and a stdout writer —
  is a few dozen lines; three direct packages (`pino`, `pino-http`, `nestjs-pino`) plus pino's own 11
  runtime dependencies are not justified for it
  (AGENTS.md: prefer no new dependency). pino's throughput advantage (async/worker-thread
  transports) does not matter at our volume; revisit if logging shows up in profiles or when an
  error-tracking transport is needed (P12-05).
- **Nest's `ConsoleLogger` with `json: true`** (built in): JSON output without request context or
  redaction; extending it means overriding internal formatting methods. Not taken.
- **Redaction at call sites only** (discipline, no safety net): contradicts "mandatory redaction"
  in the backlog item and SECURITY.md. Not taken.

## Consequences

- No new dependency (ADR-0001 addendum records the evaluation).
- Logs are machine-parseable and correlate with the `requestId` users see in error bodies; the
  worker integration test asserts that every worker line is JSON and that job lines carry the job
  identity.
- Developers get stack frames but not error messages outside development; reproduce locally with
  `NODE_ENV=development` (or `LOG_FORMAT=pretty` for readable output).
- The key list can redact a harmless field with a matching name (e.g. a `content` field that is
  not user content); that is the intended bias. Free text in log messages is only pattern-scrubbed,
  so messages must stay free of user data.
- Follow-ups: P2-03 calls `setRequestUserId`; P12-05 adds error tracking/metrics on top of these
  lines (and may revisit pino transports); a worker health endpoint is still open.
