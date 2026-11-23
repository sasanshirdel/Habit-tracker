// Public surface for the worker process (backlog P1-03), published to apps/worker as the
// `@habit/api/worker` package export. The worker app owns the process lifecycle (signals, exit
// codes); everything it runs lives here so it shares the API's modules and conventions.
export { JOB_HANDLERS, type JobContext, type JobHandler } from './job-handler.js';
export { JOB_REJECTION, createJobProcessor, indexHandlers } from './job-processor.js';
export { SystemNoopJobHandler } from './system-noop.handler.js';
export { createWorkerContext, shutdownWorker } from './worker.factory.js';
// The worker process creates the logger itself so startup failures are logged in the same format.
export { createLogger, type JsonLogger } from '../common/logging/json-logger.js';
export {
  DISCONNECT_TIMEOUT_MS,
  WorkerHost,
  drainWorkers,
  type DrainResult,
  type DrainableWorker,
} from './worker-host.service.js';
export { WorkerModule } from './worker.module.js';
