import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createLogger, createWorkerContext, shutdownWorker } from '@habit/api/worker';
import { errorName, installShutdownHandlers } from './lifecycle.js';

// Structured JSON logs (backlog P1-07). Created before the context so a startup failure is
// reported in the same format.
const processLogger = createLogger('worker');

/**
 * Worker process entry point (backlog P1-03). Boots the API's `WorkerModule` as a Nest application
 * context (no HTTP server) and owns the process lifecycle: signals, graceful drain, exit codes.
 */
async function main(): Promise<void> {
  const logger = new Logger('WorkerProcess');
  const context = await createWorkerContext(processLogger);
  installShutdownHandlers(() => shutdownWorker(context), process, logger);
  logger.log('Worker started.');
}

main().catch((error: unknown) => {
  // Invalid configuration is reported (variable names only, never values) and exits 1 through
  // Nest's own bootstrap error handling; this catches anything else that escapes startup.
  // Configuration messages are safe to print; for other errors only the class/code is printed.
  const detail =
    error instanceof Error && error.message.startsWith('Invalid environment configuration')
      ? error.message
      : errorName(error);
  processLogger.fatal(`Worker failed to start: ${detail}`, 'WorkerProcess');
  process.exit(1);
});
