import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

/**
 * Liveness probe. Readiness checks (database, Redis, queues) are added in
 * Phase 1 when those dependencies are wired in. Must never expose secrets,
 * versions of internal dependencies, or configuration values.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
