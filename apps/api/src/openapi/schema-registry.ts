import type { z } from 'zod';

/** Metadata of a named OpenAPI component schema. */
export interface ComponentMeta {
  /** Component name, PascalCase: becomes `#/components/schemas/<id>`. */
  id: string;
  description?: string;
}

/** Registered components by id. */
const components = new Map<string, z.ZodType>();

const COMPONENT_ID = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Publishes a schema as the named OpenAPI component `meta.id` (backlog P1-06, ADR-0012) and returns
 * the schema to use from then on:
 *
 *     export const healthResponseSchema = component(z.strictObject({ … }), { id: 'HealthResponse' });
 *
 * zod keeps the id in its global registry (`.meta({ id })`), which is what makes `z.toJSONSchema`
 * emit a `$ref` wherever the schema is nested. Only schemas that go through this function carry an
 * id in this codebase; ids are global and must be unique.
 */
export function component<S extends z.ZodType>(schema: S, meta: ComponentMeta): S {
  if (!COMPONENT_ID.test(meta.id)) {
    throw new Error(`OpenAPI component id "${meta.id}" must be PascalCase ([A-Z][A-Za-z0-9]*).`);
  }
  if (components.has(meta.id)) throw new Error(`Duplicate OpenAPI component id "${meta.id}".`);
  // `.meta()` returns a registered copy; the original schema stays anonymous.
  const registered = schema.meta({ ...meta });
  components.set(meta.id, registered);
  return registered;
}

/** Ids of every registered component, sorted. */
export function componentIds(): string[] {
  return [...components.keys()].sort();
}

/** The registered schema for an id. */
export function componentSchema(id: string): z.ZodType | undefined {
  return components.get(id);
}

/** The component id of a schema, if it was registered with {@link component}. */
export function componentIdOf(schema: z.ZodType): string | undefined {
  for (const [id, registered] of components) if (registered === schema) return id;
  return undefined;
}
