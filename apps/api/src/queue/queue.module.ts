import { Global, Module } from '@nestjs/common';
import { QueueProducer } from './queue-producer.service.js';
import { RedisConnection } from './redis-connection.service.js';
import { RedisHealthIndicator } from './redis.health.js';

/**
 * Platform queue module (backlog P1-03): the shared Redis connection, the queue producer and the
 * Redis readiness check. Global so feature modules can enqueue their own jobs without re-importing
 * it; each module defines its jobs (`defineJob`) next to its code (ADR-0006). Consumers run in the
 * worker process (`WorkerModule`), never in the API.
 */
@Global()
@Module({
  providers: [RedisConnection, RedisHealthIndicator, QueueProducer],
  exports: [RedisConnection, RedisHealthIndicator, QueueProducer],
})
export class QueueModule {}
