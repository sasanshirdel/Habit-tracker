/** Status of one dependency in a readiness check. */
export type DependencyStatus = 'up' | 'down';

/** `GET /api/v1/health` — liveness. */
export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  /** ISO 8601 instant (UTC). */
  timestamp: string;
}

/** `GET /api/v1/health/ready` — readiness (200 when every check is up, 503 otherwise). */
export interface ReadinessResponse {
  status: 'ok' | 'error';
  checks: { database: DependencyStatus };
  /** ISO 8601 instant (UTC). */
  timestamp: string;
}
