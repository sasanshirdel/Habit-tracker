// Platform API conventions (backlog P1-05): error envelope, validation, pagination, request ids.
export {
  AllExceptionsFilter,
  mapException,
  type MappedError,
} from './errors/all-exceptions.filter.js';
export { ApiException, codeForStatus } from './errors/api-exception.js';
export {
  decodeCursor,
  encodeCursor,
  paginate,
  sortSchema,
  type SortDirection,
  type SortField,
} from './pagination/pagination.js';
export {
  REQUEST_ID_HEADER,
  currentRequestId,
  resolveRequestId,
  runWithRequestContext,
  type RequestContext,
} from './request/request-context.js';
export { requestIdMiddleware, type RequestWithId } from './request/request-id.middleware.js';
export {
  ZodValidationPipe,
  toValidationIssues,
  validationFailed,
} from './validation/zod-validation.pipe.js';
