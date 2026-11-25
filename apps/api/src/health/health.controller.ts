import { Controller, Get, HttpStatus } from '@nestjs/common';
import type { HealthResponse, ReadinessErrorDetails, ReadinessResponse } from '@habit/shared-types';
import { ApiException } from '../common/errors/api-exception.js';
import { DatabaseHealthIndicator } from '../database/index.js';
import { RedisHealthIndicator } from '../queue/redis.health.js';
import { SkipRateLimit } from '../rate-limit/rate-limit.guard.js';

// Response contracts live in @habit/shared-types so web and api share one definition (P1-04).
export type { HealthResponse, ReadinessResponse };

/**
 * Health probes. Must never expose secrets, connection details, versions of internal
 * dependencies, driver error messages or configuration values.
 *
 * - `GET /api/v1/health` — liveness: the process is up. Does not touch dependencies, so a database
 *   outage never causes an orchestrator to restart healthy instances.
 * - `GET /api/v1/health/ready` — readiness: dependencies needed to serve traffic are reachable.
 *   200 when all are up (PostgreSQL and Redis — Redis since backlog P1-03), 503 otherwise.
 *   Both checks run in parallel and are individually time-bounded.
 *
 * Exempt from rate limiting (P1-08): orchestrators and load balancers poll these every few seconds
 * from a handful of addresses, and a throttled probe would take healthy instances out of service.
 * They read no user data and are cheap (the readiness checks are time-bounded).
 */
@SkipRateLimit()
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready(): Promise<ReadinessResponse> {
    const [database, redis] = await Promise.all([this.database.check(), this.redis.check()]);
    if (database !== 'up' || redis !== 'up') {
      // Standard error envelope (P1-05); details name each dependency's status, nothing more.
      const details: ReadinessErrorDetails = { checks: { database, redis } };
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'NOT_READY',
        'Service not ready.',
        details,
      );
    }
    const body: ReadinessResponse = {
      status: 'ok',
      checks: { database, redis },
      timestamp: new Date().toISOString(),
    };
    return body;
  }
}
