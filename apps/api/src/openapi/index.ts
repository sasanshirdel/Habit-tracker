// OpenAPI from zod (backlog P1-06, ADR-0012).
export {
  ApiDoc,
  ApiExclude,
  ApiTag,
  type ApiDocOptions,
  type ApiDocResponse,
} from './api-doc.decorator.js';
export {
  apiErrorCodeSchema,
  apiErrorSchema,
  errorEnvelopeWith,
  pageInfoSchema,
  paginatedSchema,
  rateLimitErrorDetailsSchema,
  rateLimitedErrorSchema,
  validationErrorDetailsSchema,
  validationFailedErrorSchema,
  validationIssueSchema,
} from './common.schemas.js';
export {
  OPENAPI_INFO,
  OpenApiGenerationError,
  buildOpenApiDocument,
  toJsonSchema,
  toOpenApiPath,
  type OpenApiDocument,
} from './openapi.document.js';
export { API_DOCS_PATH, registerApiDocs } from './openapi.route.js';
export { assertValidOpenApiDocument, validateOpenApiDocument } from './openapi.validate.js';
export { component, componentIdOf, componentIds, type ComponentMeta } from './schema-registry.js';
