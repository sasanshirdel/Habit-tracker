import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const API_DOC_METADATA = 'habit:openapi:operation';
export const API_TAG_METADATA = 'habit:openapi:tag';
export const API_EXCLUDE_METADATA = 'habit:openapi:exclude';

/** One documented response. Omit `schema` for responses without a body (e.g. 204). */
export interface ApiDocResponse {
  description: string;
  schema?: z.ZodType;
}

/** What a route declares about itself in the OpenAPI document (backlog P1-06, ADR-0012). */
export interface ApiDocOptions {
  /** Unique, camelCase, stable: client generators name functions after it. */
  operationId: string;
  summary: string;
  description?: string;
  /**
   * Responses by status code. At least one 2xx is required. Standard error responses (400 for
   * validated input, 429 for rate-limited routes, `default` for everything else) are added by the
   * generator; declare a status here only to document a route-specific body for it.
   */
  responses: Record<number, ApiDocResponse>;
  deprecated?: boolean;
}

/**
 * Documents a route in the OpenAPI document. Request parameters and bodies are **not** declared
 * here: they are read from the route's `ZodValidationPipe`s, so the document always shows exactly
 * what the server validates. Every routed handler must carry `@ApiDoc` or `@ApiExclude` —
 * the generator refuses to build a document otherwise.
 */
export function ApiDoc(options: ApiDocOptions): MethodDecorator {
  return SetMetadata(API_DOC_METADATA, options);
}

/** Groups a controller's operations under one tag (e.g. `Health`). */
export function ApiTag(name: string, description?: string): ClassDecorator {
  return SetMetadata(API_TAG_METADATA, { name, description });
}

/**
 * Leaves a route or controller out of the public document. Required for admin routes
 * (`/api/v1/admin/*`, ADR-0005), which the generator refuses to publish even if documented.
 * An excluded route is still served and still validated; exclusion only hides it from docs.
 */
export function ApiExclude(): MethodDecorator & ClassDecorator {
  return SetMetadata(API_EXCLUDE_METADATA, true);
}
