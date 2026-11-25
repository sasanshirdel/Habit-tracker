import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { MetadataScanner, Reflector, type ModulesContainer } from '@nestjs/core';
import { z } from 'zod';
import { REQUEST_ID_HEADER } from '../common/request/request-context.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { routeRateLimitPolicies } from '../rate-limit/rate-limit.guard.js';
import {
  API_DOC_METADATA,
  API_EXCLUDE_METADATA,
  API_TAG_METADATA,
  type ApiDocOptions,
  type ApiDocResponse,
} from './api-doc.decorator.js';
import {
  apiErrorSchema,
  rateLimitedErrorSchema,
  validationFailedErrorSchema,
} from './common.schemas.js';
import { componentIdOf, componentIds, componentSchema } from './schema-registry.js';

/**
 * OpenAPI 3.1 document generated from the running app's routes and their zod schemas
 * (backlog P1-06, ADR-0012). No `@nestjs/swagger`: zod 4's own JSON Schema conversion
 * (`z.toJSONSchema`, draft 2020-12 — the dialect of OpenAPI 3.1) turns the very schemas the
 * `ZodValidationPipe`s enforce into the documented parameters and bodies.
 *
 * The generator is strict on purpose — it throws (and so fails the unit test and the CI export)
 * when a route has no `@ApiDoc`, reads input without a zod pipe, uses a path it cannot express,
 * repeats an `operationId`, or is an admin route that is not `@ApiExclude`d.
 */

export const OPENAPI_VERSION = '3.1.1';
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export interface OpenApiInfo {
  title: string;
  version: string;
  description: string;
}

/** Version of the `/api/v1` contract document (not the app release). */
export const OPENAPI_INFO: OpenApiInfo = {
  title: 'Habit Tracker API',
  version: '1.0.0',
  description:
    'REST API v1. Errors use one envelope `{ error: { code, message, details?, requestId } }`; ' +
    'clients localise by `code`. Lists use cursor pagination (`?limit=&cursor=`). Every response ' +
    'carries `x-request-id`. Generated from the server’s zod schemas — the source of truth.',
};

// JSON Schema / OpenAPI objects are open-ended JSON; this is the honest type for them.
type Json = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: string;
  jsonSchemaDialect: string;
  info: OpenApiInfo;
  servers: { url: string; description: string }[];
  tags: { name: string; description?: string }[];
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json>; headers: Record<string, Json> };
}

export interface BuildOptions {
  /** Base path the paths are relative to (Nest's global prefix). */
  basePath: string;
  info?: OpenApiInfo;
}

export class OpenApiGenerationError extends Error {
  override readonly name = 'OpenApiGenerationError';
  constructor(readonly problems: string[]) {
    super(`Cannot build the OpenAPI document:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

const HTTP_METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.OPTIONS]: 'options',
  [RequestMethod.HEAD]: 'head',
};

const ref = (id: string): Json => ({ $ref: `#/components/schemas/${id}` });
const headerRef = (name: string): Json => ({ $ref: `#/components/headers/${name}` });

const HEADERS: Record<string, Json> = {
  RequestId: {
    description: 'Request id (echoed when the caller sent a valid one); quote it to support.',
    schema: { type: 'string' },
  },
  RateLimitLimit: {
    description: 'Requests allowed in the current window of the tightest policy.',
    schema: { type: 'integer', minimum: 1 },
  },
  RateLimitRemaining: {
    description: 'Requests left in the current window of the tightest policy.',
    schema: { type: 'integer', minimum: 0 },
  },
  RateLimitReset: {
    description: 'Seconds until the current window of the tightest policy ends.',
    schema: { type: 'integer', minimum: 1 },
  },
  RetryAfter: {
    description: 'Seconds to wait before retrying.',
    schema: { type: 'integer', minimum: 1 },
  },
};

const RATE_LIMIT_HEADERS: Record<string, Json> = {
  'RateLimit-Limit': headerRef('RateLimitLimit'),
  'RateLimit-Remaining': headerRef('RateLimitRemaining'),
  'RateLimit-Reset': headerRef('RateLimitReset'),
};

/** `:id` → `{id}`; anything Express-specific (wildcards, regex, optional parts) is refused. */
export function toOpenApiPath(nestPath: string): { path: string; params: string[] } | undefined {
  const segments = nestPath.split('/').filter(Boolean);
  const params: string[] = [];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return undefined;
      params.push(name);
      out.push(`{${name}}`);
    } else if (/^[A-Za-z0-9._~-]+$/.test(segment)) {
      out.push(segment);
    } else {
      return undefined;
    }
  }
  return { path: `/${out.join('/')}`, params };
}

function joinPaths(...parts: string[]): string {
  return `/${parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/')}`;
}

/**
 * Response objects are documented as open (no `additionalProperties: false`): adding a response
 * field is a compatible change (ADR-0009), so generated clients must not reject unknown fields.
 * The zod schemas themselves stay strict, so tests that parse real responses with them still
 * catch an undocumented field.
 */
const openResponseObjects = (ctx: { jsonSchema: Json }): void => {
  if (ctx.jsonSchema.additionalProperties === false) delete ctx.jsonSchema.additionalProperties;
};

function stripSchemaKeywords(json: Json): Json {
  const { $schema: _schema, $id: _id, ...rest } = json;
  return rest;
}

/**
 * zod → JSON Schema 2020-12. Named components (registered with `component()`) nested in `schema`
 * become `$ref`s to `#/components/schemas/<id>`; a named schema itself becomes a plain `$ref`.
 * `io: 'input'` documents what a client may send (before coercion/defaults); `'output'` what the
 * server returns.
 */
export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const id = componentIdOf(schema);
  if (id && io === 'output') return ref(id);
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'throw',
    reused: 'inline',
    ...(io === 'output' ? { override: openResponseObjects } : {}),
  }) as Json;
  const defs = json.$defs as Record<string, Json> | undefined;
  if (defs) {
    if (io === 'input') {
      // Components are published in their output form; a request referencing one could document
      // the wrong shape (defaults/coercion differ). Keep request schemas self-contained.
      throw new Error(
        `request schemas must not nest registered components (${Object.keys(defs).join(', ')})`,
      );
    }
    for (const key of Object.keys(defs)) {
      if (!componentSchema(key))
        throw new Error(`schema has an unnamed shared definition "${key}"`);
    }
  }
  const { $defs: _defs, ...rest } = stripSchemaKeywords(json);
  return JSON.parse(JSON.stringify(rest).replaceAll('"#/$defs/', '"#/components/schemas/')) as Json;
}

function schemaOfComponents(): Record<string, Json> {
  const result = z.toJSONSchema(z.globalRegistry, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'throw',
    override: openResponseObjects,
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Json> };
  const schemas: Record<string, Json> = {};
  // Only our components: other libraries could put ids in zod's global registry.
  for (const id of componentIds()) {
    const json = result.schemas[id];
    if (json) schemas[id] = stripSchemaKeywords(json);
  }
  return schemas;
}

interface RouteArg {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

interface Operation {
  path: string;
  method: string;
  object: Json;
}

/** Builds the document from every controller registered in the app's modules. */
export function buildOpenApiDocument(
  modules: ModulesContainer,
  options: BuildOptions,
): OpenApiDocument {
  const problems: string[] = [];
  const reflector = new Reflector();
  const scanner = new MetadataScanner();
  const tags = new Map<string, string | undefined>();
  const operations: Operation[] = [];
  const operationIds = new Map<string, string>();

  const controllers = new Set<Type<unknown>>();
  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      if (typeof wrapper.metatype === 'function') {
        controllers.add(wrapper.metatype as Type<unknown>);
      }
    }
  }

  for (const controller of controllers) {
    const controllerName = controller.name;
    const classExcluded = Reflect.getMetadata(API_EXCLUDE_METADATA, controller) === true;
    const tag = Reflect.getMetadata(API_TAG_METADATA, controller) as
      { name: string; description?: string } | undefined;
    const prefixes = [
      Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined,
    ]
      .flat()
      .map((p) => p ?? '/');
    const prototype = controller.prototype as Record<string, unknown>;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[methodName] as (...args: never[]) => unknown;
      const routePaths = Reflect.getMetadata(PATH_METADATA, handler) as
        string | string[] | undefined;
      if (routePaths === undefined) continue; // not a route handler
      const where = `${controllerName}.${methodName}`;
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
      const method = HTTP_METHODS[requestMethod];
      const excluded = classExcluded || Reflect.getMetadata(API_EXCLUDE_METADATA, handler) === true;

      const fullPaths = prefixes.flatMap((prefix) =>
        [routePaths].flat().map((p) => joinPaths(prefix, p)),
      );
      for (const fullPath of fullPaths) {
        const isAdmin = /^\/admin(\/|$)/.test(fullPath);
        if (excluded) continue;
        if (isAdmin) {
          problems.push(`${where}: admin route ${fullPath} must be @ApiExclude()d (ADR-0005).`);
          continue;
        }
        if (!method) {
          problems.push(`${where}: HTTP method ${String(requestMethod)} cannot be documented.`);
          continue;
        }
        const converted = toOpenApiPath(fullPath);
        if (!converted) {
          problems.push(`${where}: path ${fullPath} cannot be expressed in OpenAPI.`);
          continue;
        }
        const doc = Reflect.getMetadata(API_DOC_METADATA, handler) as ApiDocOptions | undefined;
        if (!doc) {
          problems.push(`${where}: ${method.toUpperCase()} ${fullPath} has no @ApiDoc().`);
          continue;
        }
        const previous = operationIds.get(doc.operationId);
        if (previous) {
          problems.push(`${where}: operationId "${doc.operationId}" already used by ${previous}.`);
          continue;
        }
        operationIds.set(doc.operationId, where);
        if (!/^[a-z][A-Za-z0-9]*$/.test(doc.operationId)) {
          problems.push(`${where}: operationId "${doc.operationId}" must be camelCase.`);
        }
        if (tag) tags.set(tag.name, tag.description);

        try {
          const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, methodName) ??
            {}) as Record<string, RouteArg>;
          const object = buildOperation({
            doc,
            tag: tag?.name,
            args,
            pathParams: converted.params,
            policies: routeRateLimitPolicies(reflector, handler, controller),
          });
          operations.push({ path: converted.path, method, object });
        } catch (error) {
          problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  if (problems.length > 0) throw new OpenApiGenerationError(problems);

  const paths: OpenApiDocument['paths'] = {};
  for (const op of operations.sort((a, b) => a.path.localeCompare(b.path))) {
    paths[op.path] ??= {};
    paths[op.path]![op.method] = op.object;
  }

  const document: OpenApiDocument = {
    openapi: OPENAPI_VERSION,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: options.info ?? OPENAPI_INFO,
    servers: [{ url: joinPaths(options.basePath), description: 'This API (same origin).' }],
    tags: [...tags.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, description]) => (description ? { name, description } : { name })),
    paths,
    components: { schemas: {}, headers: HEADERS },
  };
  document.components.schemas = reachableComponents(document, schemaOfComponents());
  return document;
}

interface OperationInput {
  doc: ApiDocOptions;
  tag: string | undefined;
  args: Record<string, RouteArg>;
  pathParams: string[];
  policies: ReturnType<typeof routeRateLimitPolicies>;
}

function zodPipeOf(arg: RouteArg): ZodValidationPipe<z.ZodType> | undefined {
  return arg.pipes?.find((p): p is ZodValidationPipe<z.ZodType> => p instanceof ZodValidationPipe);
}

function objectProperties(
  json: Json,
  what: string,
): { props: Record<string, Json>; required: Set<string> } {
  if (json.type !== 'object' || typeof json.properties !== 'object' || json.properties === null) {
    throw new Error(`${what} schema must be a zod object`);
  }
  return {
    props: json.properties as Record<string, Json>,
    required: new Set((json.required as string[] | undefined) ?? []),
  };
}

function parameter(
  name: string,
  location: 'path' | 'query',
  schema: Json,
  required: boolean,
): Json {
  const { description, ...rest } = schema;
  return {
    name,
    in: location,
    required: location === 'path' ? true : required,
    ...(typeof description === 'string' ? { description } : {}),
    schema: rest,
  };
}

function buildOperation(input: OperationInput): Json {
  const { doc, args, pathParams, policies } = input;
  const parameters: Json[] = [];
  let requestBody: Json | undefined;
  let validated = false;
  const documentedPathParams = new Set<string>();

  for (const [key, arg] of Object.entries(args)) {
    const type = Number(key.split(':')[0]);
    if (![RouteParamtypes.BODY, RouteParamtypes.QUERY, RouteParamtypes.PARAM].includes(type)) {
      continue; // @Req, @Res, @Headers, @Ip, custom decorators: not client input we document
    }
    const location =
      type === RouteParamtypes.BODY ? 'body' : type === RouteParamtypes.QUERY ? 'query' : 'path';
    const pipe = zodPipeOf(arg);
    if (!pipe) throw new Error(`${location} input without a ZodValidationPipe (ADR-0009)`);
    validated = true;
    const json = toJsonSchema(pipe.schema, 'input');
    const name = typeof arg.data === 'string' ? arg.data : undefined;

    if (location === 'body') {
      if (name) throw new Error('@Body(name) is not supported; validate the whole body');
      requestBody = { required: true, content: { 'application/json': { schema: json } } };
    } else if (name) {
      parameters.push(parameter(name, location, json, true));
      if (location === 'path') documentedPathParams.add(name);
    } else {
      const { props, required } = objectProperties(json, location);
      for (const [prop, propSchema] of Object.entries(props)) {
        parameters.push(parameter(prop, location, propSchema, required.has(prop)));
        if (location === 'path') documentedPathParams.add(prop);
      }
    }
  }

  const missing = pathParams.filter((p) => !documentedPathParams.has(p));
  const extra = [...documentedPathParams].filter((p) => !pathParams.includes(p));
  if (missing.length > 0)
    throw new Error(`path parameter(s) without a schema: ${missing.join(', ')}`);
  if (extra.length > 0)
    throw new Error(`schema names unknown path parameter(s): ${extra.join(', ')}`);

  const statuses = Object.keys(doc.responses).map(Number);
  if (!statuses.some((s) => s >= 200 && s < 300)) throw new Error('no 2xx response declared');
  const rateLimited = policies.length > 0;

  const responses: Record<string, Json> = {};
  for (const status of statuses.sort((a, b) => a - b)) {
    responses[String(status)] = response(doc.responses[status]!, {
      rateLimitHeaders: rateLimited && status < 400,
    });
  }
  if (validated && !responses['400']) {
    responses['400'] = response(
      {
        description: requestBody
          ? 'Invalid input (`VALIDATION_FAILED`). Unparseable JSON answers `MALFORMED_REQUEST_BODY` in the generic envelope.'
          : 'Invalid input (`VALIDATION_FAILED`).',
        schema: validationFailedErrorSchema,
      },
      { rateLimitHeaders: rateLimited },
    );
  }
  if (rateLimited && !responses['429']) {
    responses['429'] = {
      ...response(
        { description: 'Rate limit exceeded (`RATE_LIMITED`).', schema: rateLimitedErrorSchema },
        { rateLimitHeaders: true },
      ),
    };
    (responses['429'].headers as Json)['Retry-After'] = headerRef('RetryAfter');
  }
  if (policies.some((p) => p.onStoreFailure === 'deny') && !responses['503']) {
    responses['503'] = response(
      {
        description: 'Rate-limit store unavailable on a fail-closed route (`SERVICE_UNAVAILABLE`).',
        schema: apiErrorSchema,
      },
      { rateLimitHeaders: false },
    );
  }
  responses.default = response(
    {
      description:
        'Any other error in the standard envelope, e.g. 404 `NOT_FOUND` or 500 `INTERNAL_ERROR`.',
      schema: apiErrorSchema,
    },
    { rateLimitHeaders: false },
  );

  return {
    operationId: doc.operationId,
    summary: doc.summary,
    ...(doc.description ? { description: doc.description } : {}),
    ...(input.tag ? { tags: [input.tag] } : {}),
    ...(doc.deprecated ? { deprecated: true } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
    // Rate-limit classes the route counts against (ADR-0011); absent for exempt probes.
    ...(policies.length > 0
      ? {
          'x-rate-limit': policies.map((p) => ({
            policy: p.name,
            limit: p.limit,
            windowSeconds: p.windowSeconds,
          })),
        }
      : {}),
  };
}

function response(spec: ApiDocResponse, opts: { rateLimitHeaders: boolean }): Json {
  const headers: Json = { [REQUEST_ID_HEADER]: headerRef('RequestId') };
  if (opts.rateLimitHeaders) Object.assign(headers, RATE_LIMIT_HEADERS);
  return {
    description: spec.description,
    headers,
    ...(spec.schema
      ? { content: { 'application/json': { schema: toJsonSchema(spec.schema, 'output') } } }
      : {}),
  };
}

/** Keeps only the components the paths reference, directly or through other components. */
function reachableComponents(
  document: OpenApiDocument,
  all: Record<string, Json>,
): Record<string, Json> {
  const prefix = '#/components/schemas/';
  const seen = new Set<string>();
  const queue: unknown[] = [document.paths];
  while (queue.length > 0) {
    const node = queue.pop();
    if (Array.isArray(node)) {
      queue.push(...(node as unknown[]));
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string' && value.startsWith(prefix)) {
          const id = value.slice(prefix.length);
          if (!seen.has(id)) {
            seen.add(id);
            queue.push(all[id]);
          }
        } else {
          queue.push(value);
        }
      }
    }
  }
  const result: Record<string, Json> = {};
  for (const id of [...seen].sort()) {
    const schema = all[id];
    if (!schema) throw new OpenApiGenerationError([`unknown component "${id}" referenced`]);
    result[id] = schema;
  }
  return result;
}
