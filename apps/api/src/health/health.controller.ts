import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseHealthIndicator, type DependencyStatus } from '../database/index.js';

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessResponse {
  status: 'ok' | 'error';
  checks: { database: DependencyStatus };
  timestamp: string;
}

/**
 * Health probes. Must never expose secrets, connection details, versions of internal
 * dependencies, driver error messages or configuration values.
 *
 * - `GET /api/v1/health` — liveness: the process is up. Does not touch dependencies, so a database
 *   outage never causes an orchestrator to restart healthy instances.
 * - `GET /api/v1/health/ready` — readiness: dependencies needed to serve traffic are reachable.
 *   200 when all are up, 503 otherwise. Redis/queues are added with backlog P1-03.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseHealthIndicator) {}

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
    const database = await this.database.check();
    const body: ReadinessResponse = {
      status: database === 'up' ? 'ok' : 'error',
      checks: { database },
      timestamp: new Date().toISOString(),
    };
    if (body.status !== 'ok') {
      // The global error format (backlog P1-05) will wrap this; the body stays code-like and
      // free of internals.
      throw new ServiceUnavailableException(body);
    }
    return body;
  }
}
