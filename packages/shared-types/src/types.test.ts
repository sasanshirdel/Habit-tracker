import { describe, expectTypeOf, it } from 'vitest';
import type {
  ApiErrorBody,
  ApiErrorCode,
  DependencyStatus,
  HealthResponse,
  Paginated,
  ReadinessResponse,
  ValidationIssue,
} from './index.js';

// Type-level contract tests: they fail `vitest`/`tsc` if a shared shape changes unexpectedly.
describe('@habit/shared-types', () => {
  it('readiness response shape', () => {
    expectTypeOf<ReadinessResponse['status']>().toEqualTypeOf<'ok'>();
    expectTypeOf<ReadinessResponse['checks']>().toEqualTypeOf<{
      database: DependencyStatus;
      redis: DependencyStatus;
    }>();
    expectTypeOf<DependencyStatus>().toEqualTypeOf<'up' | 'down'>();
  });

  it('liveness response shape', () => {
    expectTypeOf<HealthResponse>().toEqualTypeOf<{
      status: 'ok';
      uptimeSeconds: number;
      timestamp: string;
    }>();
  });

  it('error envelope shape (ARCHITECTURE §5)', () => {
    expectTypeOf<ApiErrorBody['error']>().toEqualTypeOf<{
      code: string;
      message: string;
      details?: unknown;
      requestId: string;
    }>();
  });

  it('validation issue and pagination shapes (P1-05)', () => {
    expectTypeOf<ValidationIssue>().toEqualTypeOf<{
      field: string;
      code: string;
      message: string;
    }>();
    expectTypeOf<Paginated<number>>().toEqualTypeOf<{
      data: number[];
      page: { nextCursor: string | null; hasMore: boolean; limit: number };
    }>();
    expectTypeOf<'VALIDATION_FAILED'>().toExtend<ApiErrorCode>();
    expectTypeOf<'NOT_READY'>().toExtend<ApiErrorCode>();
  });
});
