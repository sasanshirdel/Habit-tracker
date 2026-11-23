/** The bits of `process` the lifecycle needs (narrow, so it can be unit-tested). */
export interface ProcessLike {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): void;
}

export interface LifecycleLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Graceful shutdown for the worker process:
 * - the first SIGTERM/SIGINT runs `shutdown` (drain in-flight jobs, then close connections) and
 *   exits 0 on success, 1 on failure;
 * - a second signal while draining exits 1 immediately (operator insists; unfinished jobs are
 *   recovered as stalled by another worker).
 */
export function installShutdownHandlers(
  shutdown: () => Promise<unknown>,
  proc: ProcessLike,
  logger: LifecycleLogger,
): void {
  let shuttingDown = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    proc.on(signal, () => {
      if (shuttingDown) {
        logger.warn(`Received ${signal} again; exiting without waiting for jobs.`);
        proc.exit(1);
        return;
      }
      shuttingDown = true;
      logger.log(`Received ${signal}; draining in-flight jobs before exit.`);
      shutdown().then(
        () => {
          logger.log('Worker stopped.');
          proc.exit(0);
        },
        (error: unknown) => {
          logger.error(`Worker shutdown failed (${errorName(error)}).`);
          proc.exit(1);
        },
      );
    });
  }
}

/** Error class name or code only — messages can carry connection details. */
export function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unknown';
}
