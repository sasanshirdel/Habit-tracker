import 'reflect-metadata';
import { Body, Controller, Get, Module, Param, Post, Query, type Type } from '@nestjs/common';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import type {
  ApiErrorBody,
  ApiErrorCode,
  HealthResponse,
  PageInfo,
  RateLimitErrorDetails,
  ReadinessErrorDetails,
  ReadinessResponse,
  ValidationErrorDetails,
} from '@habit/shared-types';
import { paginationQuerySchema } from '@habit/shared-validation';
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import { API_PREFIX } from '../app.factory.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import { apiDocsEnabled } from '../config/env.js';
import {
  healthResponseSchema,
  notReadyErrorSchema,
  readinessErrorDetailsSchema,
  readinessResponseSchema,
} from '../health/health.schemas.js';
import { RateLimit, SkipRateLimit } from '../rate-limit/rate-limit.guard.js';
import { ApiDoc, ApiExclude, ApiTag } from './api-doc.decorator.js';
import {
  apiErrorCodeSchema,
  apiErrorSchema,
  pageInfoSchema,
  paginatedSchema,
  rateLimitErrorDetailsSchema,
  validationErrorDetailsSchema,
} from './common.schemas.js';
import {
  OpenApiGenerationError,
  buildOpenApiDocument,
  toOpenApiPath,
  type OpenApiDocument,
} from './openapi.document.js';
import { validateOpenApiDocument } from './openapi.validate.js';
import { component } from './schema-registry.js';

/** Builds the document for a root module without instantiating anything (Nest preview mode). */
async function documentFor(root: Type<unknown>): Promise<OpenApiDocument> {
  const app = await NestFactory.create(root, { preview: true, logger: false });
  try {
    return buildOpenApiDocument(app.get(ModulesContainer), { basePath: API_PREFIX });
  } finally {
    await app.close();
  }
}

async function problemsFor(...controllers: Type<unknown>[]): Promise<string[]> {
  @Module({ controllers })
  class Root {}
  try {
    await documentFor(Root);
    return [];
  } catch (error) {
    if (error instanceof OpenApiGenerationError) return error.problems;
    throw error;
  }
}

type Op = Record<string, unknown> & {
  parameters?: Record<string, unknown>[];
  responses: Record<string, Record<string, unknown>>;
  requestBody?: Record<string, unknown>;
};
const op = (doc: OpenApiDocument, path: string, method: string): Op =>
  doc.paths[path]![method] as Op;

describe('OpenAPI document of the real app (AppModule)', () => {
  let doc: OpenApiDocument;
  // Built once: the first Nest bootstrap of the whole app is the slow part on a cold runner.
  beforeAll(async () => {
    doc = await documentFor(AppModule);
  }, 30_000);

  it('builds, is structurally valid and documents the health probes and auth routes', () => {
    expect(validateOpenApiDocument(doc)).toEqual([]);
    expect(doc.openapi).toBe('3.1.1');
    expect(doc.servers).toEqual([{ url: '/api/v1', description: expect.any(String) }]);
    expect(Object.keys(doc.paths)).toEqual([
      '/auth/login',
      '/auth/logout',
      '/auth/logout-everywhere',
      '/auth/register',
      '/health',
      '/health/ready',
    ]);
    expect(op(doc, '/health', 'get').operationId).toBe('getLiveness');
    expect(op(doc, '/health/ready', 'get').operationId).toBe('getReadiness');
    expect(doc.tags.map((t) => t.name)).toEqual(['Auth', 'Health']);
  });

  it('references the response components and keeps only reachable ones', () => {
    const ready = op(doc, '/health/ready', 'get');
    expect(ready.responses['200']!.content).toEqual({
      'application/json': { schema: { $ref: '#/components/schemas/ReadinessResponse' } },
    });
    expect(ready.responses['503']!.content).toEqual({
      'application/json': { schema: { $ref: '#/components/schemas/NotReadyError' } },
    });
    expect(Object.keys(doc.components.schemas)).toEqual([
      'ApiError',
      'ApiErrorCode',
      'AuthenticatedUser',
      'DependencyStatus',
      'HealthResponse',
      'InvalidCredentialsError',
      'LoginResponse',
      'NotReadyError',
      'RateLimitErrorDetails',
      'RateLimitedError',
      'ReadinessChecks',
      'ReadinessErrorDetails',
      'ReadinessResponse',
      'RegistrationAcceptedResponse',
      'UnauthenticatedError',
      'ValidationErrorDetails',
      'ValidationFailedError',
      'ValidationIssue',
    ]);
    // Unused components (PageInfo) are pruned.
    expect(doc.components.schemas.PageInfo).toBeUndefined();
  });

  it('documents probes as exempt from rate limiting (no 429, no rate-limit headers)', () => {
    for (const path of ['/health', '/health/ready']) {
      const o = op(doc, path, 'get');
      expect(o.responses['429']).toBeUndefined();
      expect(o['x-rate-limit']).toBeUndefined();
      expect(o.responses['200']!.headers).toEqual({
        'x-request-id': { $ref: '#/components/headers/RequestId' },
      });
      expect(o.responses.default!.content).toEqual({
        'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
      });
    }
  });

  it('documents response objects as open (adding a field is compatible) and enum codes', () => {
    const health = doc.components.schemas.HealthResponse!;
    expect(health.additionalProperties).toBeUndefined();
    expect(health.required).toEqual(['status', 'uptimeSeconds', 'timestamp']);
    expect(doc.components.schemas.ApiErrorCode!.enum).toContain('NOT_READY');
    // No JSON Schema keywords that clash with OpenAPI 3.1 embedding.
    const text = JSON.stringify(doc);
    expect(text).not.toContain('"$schema"');
    expect(text).not.toContain('"$id"');
    expect(text).not.toContain('#/$defs/');
  });

  it('never leaks configuration or connection details', () => {
    const text = JSON.stringify(doc);
    for (const fragment of ['127.0.0.1', 'postgresql://', 'redis://', 'unreachable', 'localhost']) {
      expect(text).not.toContain(fragment);
    }
  });
});

describe('contract schemas mirror @habit/shared-types exactly', () => {
  it('has identical types (compile-time) and accepts representative values', () => {
    expectTypeOf<z.output<typeof healthResponseSchema>>().toEqualTypeOf<HealthResponse>();
    expectTypeOf<z.output<typeof readinessResponseSchema>>().toEqualTypeOf<ReadinessResponse>();
    expectTypeOf<
      z.output<typeof readinessErrorDetailsSchema>
    >().toEqualTypeOf<ReadinessErrorDetails>();
    expectTypeOf<z.output<typeof apiErrorCodeSchema>>().toEqualTypeOf<ApiErrorCode>();
    expectTypeOf<
      z.output<typeof validationErrorDetailsSchema>
    >().toEqualTypeOf<ValidationErrorDetails>();
    expectTypeOf<
      z.output<typeof rateLimitErrorDetailsSchema>
    >().toEqualTypeOf<RateLimitErrorDetails>();
    expectTypeOf<z.output<typeof pageInfoSchema>>().toEqualTypeOf<PageInfo>();
    // The generic envelope narrows `code` to the known codes; it must stay assignable to the
    // shared (string-coded) body the web app reads.
    expectTypeOf<z.output<typeof apiErrorSchema>>().toExtend<ApiErrorBody>();

    const notReady = {
      error: {
        code: 'NOT_READY',
        message: 'Service not ready.',
        details: { checks: { database: 'down', redis: 'up' } },
        requestId: 'req-12345678',
      },
    };
    expect(notReadyErrorSchema.parse(notReady)).toEqual(notReady);
  });
});

// ---- Generator behaviour on purpose-built controllers ----------------------------------------

const itemSchema = component(z.strictObject({ id: z.uuid(), name: z.string() }), {
  id: 'TestItem',
});
const listQuery = paginationQuerySchema.extend({
  status: z.enum(['active', 'archived']).optional().meta({ description: 'Filter by status.' }),
});
const idParams = z.strictObject({ id: z.uuid() });
const createBody = z.strictObject({ name: z.string().min(1).max(100) });

@ApiTag('Items')
@Controller('items')
class ItemsController {
  @ApiDoc({
    operationId: 'listItems',
    summary: 'List items',
    responses: { 200: { description: 'A page of items.', schema: paginatedSchema(itemSchema) } },
  })
  @Get()
  list(@Query(new ZodValidationPipe(listQuery)) _query: unknown): void {}

  @ApiDoc({
    operationId: 'getItem',
    summary: 'Get an item',
    responses: { 200: { description: 'The item.', schema: itemSchema } },
  })
  @Get(':id')
  get(@Param(new ZodValidationPipe(idParams)) _params: unknown): void {}

  @RateLimit('auth')
  @ApiDoc({
    operationId: 'createItem',
    summary: 'Create an item',
    responses: { 201: { description: 'Created.', schema: itemSchema } },
  })
  @Post()
  create(@Body(new ZodValidationPipe(createBody)) _body: unknown): void {}
}

describe('generator', () => {
  @Module({ controllers: [ItemsController] })
  class ItemsModule {}

  it('documents query parameters from the zod pipe, with required flags and descriptions', async () => {
    const doc = await documentFor(ItemsModule);
    expect(validateOpenApiDocument(doc)).toEqual([]);
    const list = op(doc, '/items', 'get');
    expect(list.parameters).toEqual([
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { default: 20, type: 'integer', minimum: 1, maximum: 100 },
      },
      {
        name: 'cursor',
        in: 'query',
        required: false,
        schema: { type: 'string', minLength: 1, maxLength: 512 },
      },
      {
        name: 'status',
        in: 'query',
        required: false,
        description: 'Filter by status.',
        schema: { type: 'string', enum: ['active', 'archived'] },
      },
    ]);
    expect(list.responses['400']!.content).toEqual({
      'application/json': { schema: { $ref: '#/components/schemas/ValidationFailedError' } },
    });
  });

  it('documents path parameters and converts :id to {id}', async () => {
    const doc = await documentFor(ItemsModule);
    const get = op(doc, '/items/{id}', 'get');
    expect(get.parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: expect.objectContaining({ type: 'string', format: 'uuid' }),
      },
    ]);
  });

  it('documents JSON bodies from the input side of the schema', async () => {
    const doc = await documentFor(ItemsModule);
    const create = op(doc, '/items', 'post');
    expect(create.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('adds 429 with Retry-After and rate-limit headers, and 503 for fail-closed classes', async () => {
    const doc = await documentFor(ItemsModule);
    const create = op(doc, '/items', 'post');
    expect(create['x-rate-limit']).toEqual([
      { policy: 'default', limit: 300, windowSeconds: 60 },
      { policy: 'auth', limit: 10, windowSeconds: 300 },
    ]);
    expect(create.responses['429']!.headers).toMatchObject({
      'Retry-After': { $ref: '#/components/headers/RetryAfter' },
      'RateLimit-Limit': { $ref: '#/components/headers/RateLimitLimit' },
    });
    expect(create.responses['201']!.headers).toHaveProperty('RateLimit-Remaining');
    expect(create.responses['503']).toBeDefined();
    // The default-only list route fails open: no 503.
    expect(op(doc, '/items', 'get').responses['503']).toBeUndefined();
  });

  it('references registered components from inline response schemas', async () => {
    const doc = await documentFor(ItemsModule);
    const schema = (
      op(doc, '/items', 'get').responses['200']!.content as Record<string, { schema: unknown }>
    )['application/json']!.schema;
    expect(schema).toEqual({
      type: 'object',
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/TestItem' } },
        page: { $ref: '#/components/schemas/PageInfo' },
      },
      required: ['data', 'page'],
    });
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['TestItem', 'PageInfo', 'RateLimitedError', 'ValidationFailedError']),
    );
  });

  it('refuses an undocumented route', async () => {
    @Controller('undocumented')
    class Undocumented {
      @Get()
      get(): void {}
    }
    expect(await problemsFor(Undocumented)).toEqual([
      'Undocumented.get: GET /undocumented has no @ApiDoc().',
    ]);
  });

  it('refuses input that is not validated by a zod pipe', async () => {
    @Controller('raw')
    class Raw {
      @ApiDoc({ operationId: 'raw', summary: 'Raw', responses: { 204: { description: 'Done.' } } })
      @Post()
      post(@Body() _body: unknown): void {}
    }
    expect(await problemsFor(Raw)).toEqual([
      'Raw.post: body input without a ZodValidationPipe (ADR-0009)',
    ]);
  });

  it('refuses a path parameter without a schema', async () => {
    @Controller('things')
    class Things {
      @ApiDoc({
        operationId: 'getThing',
        summary: 'Thing',
        responses: { 200: { description: 'Ok.' } },
      })
      @Get(':id')
      get(): void {}
    }
    expect(await problemsFor(Things)).toEqual([
      'Things.get: path parameter(s) without a schema: id',
    ]);
  });

  it('refuses duplicate operation ids and routes without a 2xx', async () => {
    @Controller('dup')
    class Dup {
      @ApiDoc({ operationId: 'same', summary: 'A', responses: { 200: { description: 'Ok.' } } })
      @Get('a')
      a(): void {}

      @ApiDoc({ operationId: 'same', summary: 'B', responses: { 200: { description: 'Ok.' } } })
      @Get('b')
      b(): void {}

      @ApiDoc({
        operationId: 'onlyErrors',
        summary: 'C',
        responses: { 404: { description: 'No.' } },
      })
      @Get('c')
      c(): void {}
    }
    expect(await problemsFor(Dup)).toEqual([
      'Dup.b: operationId "same" already used by Dup.a.',
      'Dup.c: no 2xx response declared',
    ]);
  });

  it('never publishes admin routes: refuses them unless excluded, and omits excluded ones', async () => {
    @Controller('admin/users')
    class AdminUsers {
      @ApiDoc({
        operationId: 'listUsers',
        summary: 'Users',
        responses: { 200: { description: 'Ok.' } },
      })
      @Get()
      list(): void {}
    }
    expect(await problemsFor(AdminUsers)).toEqual([
      'AdminUsers.list: admin route /admin/users must be @ApiExclude()d (ADR-0005).',
    ]);

    @ApiExclude()
    @Controller('admin/users')
    class ExcludedAdmin {
      @Get()
      list(): void {}
    }
    @SkipRateLimit()
    @Controller('public')
    class PublicThing {
      @ApiDoc({
        operationId: 'getPublic',
        summary: 'P',
        responses: { 200: { description: 'Ok.' } },
      })
      @Get()
      get(): void {}

      @ApiExclude()
      @Get('hidden')
      hidden(): void {}
    }
    @Module({ controllers: [ExcludedAdmin, PublicThing] })
    class Root {}
    const doc = await documentFor(Root);
    expect(Object.keys(doc.paths)).toEqual(['/public']);
  });

  it('keeps request schemas self-contained (no component refs on the input side)', async () => {
    const nested = z.strictObject({ item: itemSchema });
    @Controller('nested')
    class Nested {
      @ApiDoc({
        operationId: 'postNested',
        summary: 'N',
        responses: { 204: { description: 'Ok.' } },
      })
      @Post()
      post(@Body(new ZodValidationPipe(nested)) _body: unknown): void {}
    }
    const problems = await problemsFor(Nested);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('request schemas must not nest registered components');
  });
});

describe('toOpenApiPath', () => {
  it('converts params and refuses Express-only syntax', () => {
    expect(toOpenApiPath('/habits/:habitId/entries/:id')).toEqual({
      path: '/habits/{habitId}/entries/{id}',
      params: ['habitId', 'id'],
    });
    expect(toOpenApiPath('/')).toEqual({ path: '/', params: [] });
    expect(toOpenApiPath('/files/*path')).toBeUndefined();
    expect(toOpenApiPath('/a/:id?')).toBeUndefined();
  });
});

describe('validateOpenApiDocument', () => {
  it('reports unresolvable refs, undeclared path params and missing 2xx', async () => {
    @Module({ controllers: [ItemsController] })
    class Root {}
    const doc = await documentFor(Root);
    const broken = structuredClone(doc);
    broken.paths['/items/{id}']!.get!.parameters = [];
    broken.paths['/items']!.get!.responses = {
      default: {
        description: 'x',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } },
      },
    };
    const problems = validateOpenApiDocument(broken);
    expect(problems).toEqual(
      expect.arrayContaining([
        'GET /items/{id}: path parameter "id" not declared',
        'GET /items: no 2xx response',
        expect.stringContaining('unresolvable $ref "#/components/schemas/Nope"'),
      ]),
    );
  });
});

describe('apiDocsEnabled', () => {
  it('serves docs outside production by default and in production only when set explicitly', () => {
    expect(apiDocsEnabled({ NODE_ENV: 'development', API_DOCS_ENABLED: undefined })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'test', API_DOCS_ENABLED: undefined })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS_ENABLED: undefined })).toBe(false);
    expect(apiDocsEnabled({ NODE_ENV: 'production', API_DOCS_ENABLED: true })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'development', API_DOCS_ENABLED: false })).toBe(false);
  });
});
