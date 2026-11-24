import type { OpenApiDocument } from './openapi.document.js';

/**
 * Structural validation of a generated document (backlog P1-06): the checks that catch the
 * mistakes a generator can make, without adding an OpenAPI validator dependency (ADR-0012):
 * - `openapi` is 3.1.x and `info` has a title and version;
 * - paths start with `/`, use only `{param}` templates, and every template parameter is declared
 *   as a required `in: path` parameter (and no undeclared path parameter exists);
 * - every operation has a unique `operationId`, at least one 2xx response, and every response a
 *   description;
 * - every `$ref` resolves inside the document;
 * - no JSON Schema keyword OpenAPI 3.1 forbids in embedded schemas leaks through (`$schema` with
 *   another dialect, `$id` fragments, leftover `$defs` refs).
 * Returns the problems found; an empty list means valid.
 */
export function validateOpenApiDocument(document: OpenApiDocument): string[] {
  const problems: string[] = [];
  if (!/^3\.1\.\d+$/.test(document.openapi))
    problems.push(`openapi "${document.openapi}" is not 3.1.x`);
  if (!document.info.title || !document.info.version) problems.push('info.title/version missing');

  const operationIds = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith('/')) problems.push(`path "${path}" must start with "/"`);
    const templateParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    if (/[{}]/.test(path.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ''))) {
      problems.push(`path "${path}" has a malformed template`);
    }
    for (const [method, operation] of Object.entries(item)) {
      const where = `${method.toUpperCase()} ${path}`;
      const id = operation.operationId;
      if (typeof id !== 'string' || id === '') problems.push(`${where}: operationId missing`);
      else if (operationIds.has(id)) problems.push(`${where}: duplicate operationId "${id}"`);
      else operationIds.add(id);

      const params = (operation.parameters ?? []) as Record<string, unknown>[];
      const pathParams = params.filter((p) => p.in === 'path');
      for (const name of templateParams) {
        const p = pathParams.find((x) => x.name === name);
        if (!p) problems.push(`${where}: path parameter "${name}" not declared`);
        else if (p.required !== true)
          problems.push(`${where}: path parameter "${name}" must be required`);
      }
      for (const p of pathParams) {
        if (!templateParams.includes(String(p.name))) {
          problems.push(`${where}: path parameter "${String(p.name)}" is not in the path`);
        }
      }
      const seenParams = new Set<string>();
      for (const p of params) {
        const key = `${String(p.in)}:${String(p.name)}`;
        if (seenParams.has(key)) problems.push(`${where}: duplicate parameter ${key}`);
        seenParams.add(key);
        if (!p.schema) problems.push(`${where}: parameter ${key} has no schema`);
      }

      const responses = (operation.responses ?? {}) as Record<string, Record<string, unknown>>;
      if (!Object.keys(responses).some((s) => /^2\d\d$/.test(s))) {
        problems.push(`${where}: no 2xx response`);
      }
      for (const [status, response] of Object.entries(responses)) {
        if (!/^([1-5]\d\d|default)$/.test(status))
          problems.push(`${where}: bad status "${status}"`);
        if (typeof response.description !== 'string' || response.description === '') {
          problems.push(`${where} ${status}: response description missing`);
        }
      }
    }
  }

  walk(document, (key, value, pointer) => {
    if (key === '$ref') {
      if (
        typeof value !== 'string' ||
        !value.startsWith('#/') ||
        resolve(document, value) === undefined
      ) {
        problems.push(`${pointer}: unresolvable $ref ${JSON.stringify(value)}`);
      }
    } else if (key === '$id' || key === '$defs') {
      problems.push(`${pointer}: unexpected "${key}" in an embedded schema`);
    } else if (key === '$schema' && pointer !== '') {
      problems.push(`${pointer}: unexpected "$schema" (the document sets jsonSchemaDialect)`);
    }
  });
  return problems;
}

/** Throws when {@link validateOpenApiDocument} finds problems. */
export function assertValidOpenApiDocument(document: OpenApiDocument): void {
  const problems = validateOpenApiDocument(document);
  if (problems.length > 0) {
    throw new Error(`Invalid OpenAPI document:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

function resolve(root: unknown, ref: string): unknown {
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!node || typeof node !== 'object' || !(key in node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function walk(
  node: unknown,
  visit: (key: string, value: unknown, pointer: string) => void,
  pointer = '',
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, visit, `${pointer}/${i}`));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      // Property *names* inside `properties` are data, not keywords (a field may be called "$id").
      if (!pointer.endsWith('/properties')) visit(key, value, pointer);
      walk(value, visit, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
  }
}
