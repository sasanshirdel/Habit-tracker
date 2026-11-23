// Public surface of the queue platform module (backlog P1-03). Also published to apps/worker as
// the `@habit/api/queue` package export.
export { InvalidJobIdError, InvalidJobPayloadError, QueueUnavailableError } from './errors.js';
export { defineJob, type JobDefinition, type JobInput, type JobPayload } from './job-definition.js';
export { SYSTEM_NOOP_JOB } from './jobs/system-noop.job.js';
export { createQueueProducerContext } from './producer.factory.js';
export {
  DEFAULT_JOB_OPTIONS,
  ENQUEUE_TIMEOUT_MS,
  QUEUE_NAMES,
  type QueueName,
} from './queue.constants.js';
export { QueueModule } from './queue.module.js';
export { QueueProducer, type EnqueueOptions, type EnqueuedJob } from './queue-producer.service.js';
export { RedisConnection } from './redis-connection.service.js';
export { RedisHealthIndicator } from './redis.health.js';
