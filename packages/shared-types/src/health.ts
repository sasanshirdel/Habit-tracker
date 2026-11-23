/** Status of one dependency in a readiness check. */
export type DependencyStatus = 'up' | 'down';

/** `GET /api/v1/health` — liveness. */
export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  /** ISO 8601 instant (UTC). */
  timestamp: string;
}

export interface ReadinessChecks {
  database: DependencyStatus;
  redis: DependencyStatus;
}

/**
 * `GET /api/v1/health/ready` — 200 body when every check is up. Otherwise 503 with the standard
 * error envelope: `code` `NOT_READY` and `details` of type `ReadinessErrorDetails` (P1-05).
 */
export interface ReadinessResponse {
  status: 'ok';
  checks: ReadinessChecks;
  /** ISO 8601 instant (UTC). */
  timestamp: string;
}

/** `details` of the 503 `NOT_READY` error. */
export interface ReadinessErrorDetails {
  checks: ReadinessChecks;
}
