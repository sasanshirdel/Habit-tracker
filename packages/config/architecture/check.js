// @ts-check
/**
 * Architecture test (backlog P1-15, ADR-0016): enforces the workspace dependency graph, the
 * layering between apps and packages, package entry points, and the API's module boundaries.
 *
 * No extra dependency: imports are read with the TypeScript compiler's parser (`typescript` is
 * already this package's peer) and resolved here with the repository's own conventions — `.js`
 * specifiers for `.ts` sources (NodeNext), extensionless/index imports (bundler), `tsconfig`
 * `paths` aliases (`@/*` in apps/web), and `package.json#exports` for `@habit/*` packages.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * @typedef {object} AppException
 * @property {string} from
 * @property {string} to
 * @property {string[]} subpaths  package export subpaths the importer may use, e.g. `./queue`
 * @property {string} reason
 *
 * @typedef {object} ApiRules
 * @property {string} package
 * @property {string} srcDir
 * @property {string} modulesDir
 * @property {string[]} compositionAreas
 * @property {string} generatedDir
 * @property {string[]} generatedImporters
 *
 * @typedef {object} ArchitectureRules
 * @property {{ app: string, package: string }} layers
 * @property {string[]} tooling
 * @property {Record<string, string[]>} allowedDependencies
 * @property {AppException[]} appExceptions
 * @property {ApiRules | null} api
 *
 * @typedef {object} Violation
 * @property {string} rule
 * @property {string} file  path relative to the repository root
 * @property {number} line
 * @property {string} message
 *
 * @typedef {object} WorkspacePackage
 * @property {string} name
 * @property {string} dir   absolute
 * @property {string} rel   relative to the root, `/`-separated
 * @property {'app' | 'package' | 'other'} kind
 * @property {Map<string, string>} deps  workspace dependency name -> package.json field
 * @property {unknown} exports
 * @property {Array<{ prefix: string, suffix: string, target: string }>} aliases
 * @property {string} manifestText
 *
 * @typedef {object} ImportRef
 * @property {string} specifier
 * @property {number} line
 * @property {boolean} typeOnly
 */

/** Source files the check reads. Declarations and generated code are only import targets. */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  'coverage',
  'playwright-report',
  'test-results',
  'blob-report',
  'generated',
]);
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join('/');

/**
 * @param {string} parent
 * @param {string} child
 */
const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** @param {string} file */
const isCodeFile = (file) =>
  CODE_EXTENSIONS.some((ext) => file.endsWith(ext)) && !/\.d\.[cm]?ts$/.test(file);

/** @param {string} file */
const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Workspace globs from `pnpm-workspace.yaml` (`packages:` list of `dir/*` entries).
 * @param {string} root
 */
function readWorkspaceGlobs(root) {
  const text = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  /** @type {string[]} */
  const globs = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const entry = /^\s+-\s+['"]?([^'"#\s]+)['"]?/.exec(line);
    if (entry?.[1]) globs.push(entry[1]);
    else if (/^\S/.test(line)) inPackages = false;
  }
  return globs;
}

/**
 * `compilerOptions.paths` of the package's own tsconfig.json, as prefix/suffix aliases.
 * @param {string} dir
 */
function readAliases(dir) {
  const file = path.join(dir, 'tsconfig.json');
  if (!isFile(file)) return [];
  const { config } = ts.readConfigFile(file, ts.sys.readFile);
  /** @type {Record<string, string[]>} */
  const paths = config?.compilerOptions?.paths ?? {};
  const base = path.resolve(dir, config?.compilerOptions?.baseUrl ?? '.');
  return Object.entries(paths).flatMap(([pattern, targets]) => {
    const [prefix = '', suffix = ''] = pattern.split('*');
    const target = targets[0];
    return target ? [{ prefix, suffix, target: path.resolve(base, target) }] : [];
  });
}

/**
 * @param {string} root
 * @param {ArchitectureRules} rules
 * @returns {WorkspacePackage[]}
 */
function readWorkspace(root, rules) {
  /** @type {WorkspacePackage[]} */
  const packages = [];
  for (const glob of readWorkspaceGlobs(root)) {
    const parent = glob.endsWith('/*') ? glob.slice(0, -2) : null;
    const dirs = parent
      ? fs
          .readdirSync(path.join(root, parent), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(root, parent, d.name))
      : [path.join(root, glob)];
    for (const dir of dirs.sort()) {
      const manifestFile = path.join(dir, 'package.json');
      if (!isFile(manifestFile)) continue;
      const manifestText = fs.readFileSync(manifestFile, 'utf8');
      const manifest = JSON.parse(manifestText);
      const rel = toPosix(path.relative(root, dir));
      /** @type {Map<string, string>} */
      const deps = new Map();
      for (const field of DEPENDENCY_FIELDS) {
        for (const name of Object.keys(manifest[field] ?? {})) {
          if (!deps.has(name)) deps.set(name, field);
        }
      }
      packages.push({
        name: manifest.name,
        dir,
        rel,
        kind: rel.startsWith(rules.layers.app)
          ? 'app'
          : rel.startsWith(rules.layers.package)
            ? 'package'
            : 'other',
        deps,
        exports: manifest.exports,
        aliases: readAliases(dir),
        manifestText,
      });
    }
  }
  return packages;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listSourceFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
        files.push(...listSourceFiles(path.join(dir, entry.name)));
      }
    } else if (entry.isFile() && isCodeFile(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files.sort();
}

/**
 * Every module specifier in a file: static/dynamic imports, re-exports, `require`,
 * `import x = require()` and `import('x')` types. `typeOnly` marks edges erased at runtime.
 * @param {string} file
 * @returns {ImportRef[]}
 */
export function extractImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  /** @type {ImportRef[]} */
  const refs = [];
  /**
   * @param {ts.Node} node
   * @param {ts.Node | undefined} specifier
   * @param {boolean} typeOnly
   */
  const add = (node, specifier, typeOnly) => {
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      refs.push({ specifier: specifier.text, line, typeOnly });
    }
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const allTypeSpecifiers =
        !!clause &&
        !clause.name &&
        !!bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      add(node, node.moduleSpecifier, !!clause && (clause.isTypeOnly || allTypeSpecifiers));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.exportClause;
      const allTypeSpecifiers =
        !!clause &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((element) => element.isTypeOnly);
      add(node, node.moduleSpecifier, node.isTypeOnly || allTypeSpecifiers);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        add(node, node.arguments[0], false);
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) add(node, argument.literal, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
}

/**
 * Resolve a path-like specifier to a file the way TypeScript/Node/Next do in this repository.
 * Returns the code file when found, else the bare absolute path (non-code assets, typos).
 * @param {string} base  absolute path the specifier points at
 */
function resolvePath(base) {
  const ext = path.extname(base);
  /** @type {string[]} */
  const candidates = [];
  const tsExtensions = /** @type {Record<string, string[]>} */ (JS_TO_TS)[ext];
  if (tsExtensions) candidates.push(...tsExtensions.map((e) => base.slice(0, -ext.length) + e));
  candidates.push(base);
  candidates.push(...CODE_EXTENSIONS.map((e) => base + e));
  candidates.push(...CODE_EXTENSIONS.map((e) => path.join(base, 'index' + e)));
  return candidates.find(isFile) ?? base;
}

/**
 * Does `subpath` (`.` or `./x`) match a key of `package.json#exports`?
 * @param {unknown} exportsField
 * @param {string} subpath
 */
function isExported(exportsField, subpath) {
  if (exportsField === undefined || exportsField === null) return subpath === '.';
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) return subpath === '.';
  const keys = Object.keys(exportsField);
  if (!keys.some((key) => key.startsWith('.'))) return subpath === '.'; // conditions only
  return keys.some((key) => {
    if (!key.includes('*')) return key === subpath;
    const [prefix = '', suffix = ''] = key.split('*');
    return (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= prefix.length + suffix.length
    );
  });
}

/**
 * Strongly connected components with more than one node, or a self-loop (Tarjan).
 * @template T
 * @param {Map<T, Set<T>>} graph
 * @returns {T[][]}
 */
export function findCycles(graph) {
  let index = 0;
  /** @type {T[]} */
  const stack = [];
  /** @type {Map<T, { index: number, low: number, onStack: boolean }>} */
  const state = new Map();
  /** @type {T[][]} */
  const cycles = [];
  /** @param {T} node */
  const strongConnect = (node) => {
    const nodeState = { index, low: index, onStack: true };
    state.set(node, nodeState);
    index += 1;
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const nextState = state.get(next);
      if (!nextState) {
        strongConnect(next);
        nodeState.low = Math.min(nodeState.low, /** @type {any} */ (state.get(next)).low);
      } else if (nextState.onStack) {
        nodeState.low = Math.min(nodeState.low, nextState.index);
      }
    }
    if (nodeState.low === nodeState.index) {
      /** @type {T[]} */
      const component = [];
      let member;
      do {
        member = /** @type {T} */ (stack.pop());
        /** @type {any} */ (state.get(member)).onStack = false;
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || graph.get(node)?.has(node)) cycles.push(component.reverse());
    }
  };
  for (const node of graph.keys()) if (!state.has(node)) strongConnect(node);
  return cycles;
}

/**
 * One concrete loop through a strongly connected component, for a readable message.
 * @template T
 * @param {Map<T, Set<T>>} graph
 * @param {T[]} component
 * @returns {T[]}
 */
function cyclePath(graph, component) {
  const members = new Set(component);
  const start = /** @type {T} */ (component[0]);
  /** @type {Map<T, T>} */
  const previous = new Map();
  const queue = [start];
  while (queue.length > 0) {
    const node = /** @type {T} */ (queue.shift());
    for (const next of graph.get(node) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) {
        /** @type {T[]} */
        const loop = [node];
        let cursor = node;
        while (cursor !== start) {
          cursor = /** @type {T} */ (previous.get(cursor));
          loop.unshift(cursor);
        }
        return [...loop, start];
      }
      if (!previous.has(next)) {
        previous.set(next, node);
        queue.push(next);
      }
    }
  }
  return [...component, start];
}

/**
 * Check the repository at `root` against `rules`.
 * @param {{ root: string, rules: ArchitectureRules }} options
 * @returns {{ violations: Violation[], packages: number, files: number, imports: number }}
 */
export function checkArchitecture({ root, rules }) {
  const workspace = readWorkspace(root, rules);
  const byName = new Map(workspace.map((pkg) => [pkg.name, pkg]));
  /** @type {Violation[]} */
  const violations = [];
  /**
   * @param {string} rule
   * @param {string} file  absolute
   * @param {number} line
   * @param {string} message
   */
  const report = (rule, file, line, message) =>
    violations.push({ rule, file: toPosix(path.relative(root, file)), line, message });

  /**
   * The layer and graph rules for one edge, shared by package.json and import checks.
   * @param {WorkspacePackage} from
   * @param {WorkspacePackage} to
   * @param {(rule: string, message: string) => void} fail
   */
  const checkEdge = (from, to, fail) => {
    if (rules.tooling.includes(to.name) || from.name === to.name) return;
    const exception = rules.appExceptions.find((e) => e.from === from.name && e.to === to.name);
    if (from.kind === 'package' && to.kind === 'app') {
      fail(
        'layer/package-depends-on-app',
        `${from.name} (packages/) must not depend on the app ${to.name}: packages never import apps.`,
      );
    } else if (from.kind === 'app' && to.kind === 'app' && !exception) {
      fail(
        'layer/app-depends-on-app',
        `${from.name} must not depend on the app ${to.name}: apps share code through packages/* (the only app → app edges are listed in appExceptions).`,
      );
    } else if (!(rules.allowedDependencies[from.name] ?? []).includes(to.name)) {
      fail(
        'workspace/edge-not-allowed',
        `${from.name} → ${to.name} is not in the allowed dependency graph (packages/config/architecture/rules.js, docs/ARCHITECTURE.md §2.1).`,
      );
    }
  };

  // ── 1. Workspace graph from package.json ─────────────────────────────────────────────────────
  /** @type {Map<string, Set<string>>} */
  const packageGraph = new Map();
  for (const pkg of workspace) {
    const manifest = path.join(pkg.dir, 'package.json');
    /** @param {string} needle */
    const lineOf = (needle) => {
      const at = pkg.manifestText.indexOf(needle);
      return at < 0 ? 1 : pkg.manifestText.slice(0, at).split('\n').length;
    };
    if (!(pkg.name in rules.allowedDependencies)) {
      report(
        'workspace/unknown-package',
        manifest,
        lineOf('"name"'),
        `${pkg.name} has no entry in allowedDependencies (packages/config/architecture/rules.js): declare what it may depend on.`,
      );
    }
    /** @type {Set<string>} */
    const edges = new Set();
    packageGraph.set(pkg.name, edges);
    for (const depName of pkg.deps.keys()) {
      const dep = byName.get(depName);
      if (!dep) continue;
      edges.add(depName);
      checkEdge(pkg, dep, (rule, message) =>
        report(rule, manifest, lineOf(`"${depName}"`), message),
      );
    }
  }
  for (const cycle of findCycles(packageGraph)) {
    const loop = cyclePath(packageGraph, cycle);
    const first = /** @type {WorkspacePackage} */ (byName.get(/** @type {string} */ (loop[0])));
    report(
      'workspace/cycle',
      path.join(first.dir, 'package.json'),
      1,
      `Workspace dependency cycle: ${loop.join(' → ')}.`,
    );
  }

  // ── 2. Imports in source ─────────────────────────────────────────────────────────────────────
  let fileCount = 0;
  let importCount = 0;
  const api = rules.api ? byName.get(rules.api.package) : undefined;
  const apiSrc = api && rules.api ? path.join(api.dir, rules.api.srcDir) : undefined;

  /**
   * API area of a file under src/: `<root>` for files directly in src/, `modules/<name>` for a
   * feature module, else the first directory (`common`, `queue`, …). Undefined outside src/.
   * @param {string} file
   */
  const apiArea = (file) => {
    if (!apiSrc || !rules.api || !isInside(apiSrc, file)) return undefined;
    const parts = toPosix(path.relative(apiSrc, file)).split('/');
    if (parts.length === 1) return '<root>';
    if (parts[0] === rules.api.modulesDir) {
      return parts.length > 2 ? `${parts[0]}/${parts[1]}` : /** @type {string} */ (parts[0]);
    }
    return /** @type {string} */ (parts[0]);
  };

  /** @type {Map<string, Set<string>>} */
  const apiAreaGraph = new Map();

  for (const pkg of workspace) {
    const files = listSourceFiles(pkg.dir);
    fileCount += files.length;
    /** @type {Map<string, Set<string>>} */
    const fileGraph = new Map();
    for (const file of files) {
      /** @type {Set<string>} */
      const runtimeEdges = new Set();
      fileGraph.set(file, runtimeEdges);
      const isTest = TEST_FILE.test(file);
      const fromArea = pkg === api ? apiArea(file) : undefined;
      for (const ref of extractImports(file)) {
        importCount += 1;
        const { specifier, line } = ref;
        /** @param {string} rule @param {string} message */
        const fail = (rule, message) => report(rule, file, line, `'${specifier}': ${message}`);

        // Workspace package imports: declared, allowed by the graph, entry points only.
        const workspaceName = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        const target = workspaceName ? byName.get(workspaceName) : undefined;
        if (target) {
          const rest = specifier.slice(/** @type {string} */ (workspaceName).length);
          const subpath = rest === '' ? '.' : `.${rest}`;
          if (target !== pkg && !pkg.deps.has(target.name)) {
            fail(
              'import/undeclared-dependency',
              `${target.name} is not declared in ${pkg.rel}/package.json.`,
            );
          }
          if (target !== pkg) checkEdge(pkg, target, fail);
          const exception = rules.appExceptions.find(
            (e) => e.from === pkg.name && e.to === target.name,
          );
          if (exception && !exception.subpaths.includes(subpath)) {
            fail(
              'layer/app-exception-subpath',
              `${pkg.name} may import only ${exception.subpaths.map((s) => target.name + s.slice(1)).join(', ')} from ${target.name} (${exception.reason}).`,
            );
          }
          if (!isExported(target.exports, subpath)) {
            fail(
              'import/deep-import',
              `${subpath} is not an entry point of ${target.name}; import only what its package.json "exports" publishes (never src/ or dist/ internals).`,
            );
          }
          continue;
        }

        // Path-like imports: relative, or a tsconfig paths alias of this package.
        /** @type {string | undefined} */
        let base;
        if (
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          specifier === '.' ||
          specifier === '..'
        ) {
          base = path.resolve(path.dirname(file), specifier);
        } else {
          const alias = pkg.aliases.find(
            (a) => specifier.startsWith(a.prefix) && specifier.endsWith(a.suffix),
          );
          if (alias) {
            const middle = specifier.slice(
              alias.prefix.length,
              specifier.length - alias.suffix.length,
            );
            base = alias.target.replace('*', middle);
          }
        }
        if (!base) continue; // third-party or built-in module
        const resolved = resolvePath(base);

        if (!isInside(pkg.dir, resolved)) {
          const owner = workspace.find((other) => isInside(other.dir, resolved));
          fail(
            'import/outside-package',
            owner
              ? `reaches into ${owner.rel} by path; depend on ${owner.name} and import its package exports instead.`
              : `resolves outside ${pkg.rel}; a workspace package imports only its own files and declared dependencies.`,
          );
          continue;
        }
        if (!ref.typeOnly && isCodeFile(resolved)) {
          runtimeEdges.add(resolved);
        }

        // API internal layering (ADR-0006).
        if (pkg !== api || !rules.api || !apiSrc || fromArea === undefined) continue;
        const toArea = apiArea(resolved);
        if (toArea === undefined) continue;
        const modulesPrefix = `${rules.api.modulesDir}/`;
        if (toArea.startsWith(modulesPrefix) && toArea !== fromArea) {
          const entry = path.join(apiSrc, toArea);
          const isEntry =
            path.dirname(resolved) === entry &&
            /^index\.[cm]?[jt]sx?$/.test(path.basename(resolved));
          if (!isEntry) {
            fail(
              'api/module-internal-import',
              `imports an internal file of the ${toArea} module; other code may use only its public entry ${rules.api.srcDir}/${toArea}/index.ts (ADR-0006).`,
            );
          }
          const platform =
            fromArea !== '<root>' &&
            !fromArea.startsWith(modulesPrefix) &&
            !rules.api.compositionAreas.includes(fromArea);
          if (platform) {
            fail(
              'api/platform-imports-module',
              `the platform area ${fromArea}/ must not depend on feature modules; only the composition root (${rules.api.srcDir}/*.ts, ${rules.api.compositionAreas.join(', ')}/) wires them in.`,
            );
          }
        }
        if (toArea === rules.api.generatedDir) {
          const allowed = rules.api.generatedImporters.some(
            (area) => fromArea === area || fromArea.startsWith(`${area}/`),
          );
          if (!allowed) {
            fail(
              'api/generated-client-import',
              `Prisma's generated client may be imported only from ${rules.api.generatedImporters.map((a) => `${rules.api?.srcDir}/${a}/`).join(' and ')}; use PrismaService from database/ (ADR-0006).`,
            );
          }
        }
        if (!isTest && fromArea !== '<root>' && toArea !== '<root>' && toArea !== fromArea) {
          const edges = apiAreaGraph.get(fromArea) ?? new Set();
          edges.add(toArea);
          apiAreaGraph.set(fromArea, edges);
        }
      }
    }

    for (const cycle of findCycles(fileGraph)) {
      const loop = cyclePath(fileGraph, cycle);
      report(
        'cycle/file',
        /** @type {string} */ (loop[0]),
        1,
        `Runtime import cycle: ${loop.map((f) => toPosix(path.relative(pkg.dir, f))).join(' → ')}. Break it (extract the shared part, or use \`import type\` when only types are shared).`,
      );
    }
  }

  // ── 3. API structure ─────────────────────────────────────────────────────────────────────────
  if (api && rules.api && apiSrc) {
    for (const cycle of findCycles(apiAreaGraph)) {
      const loop = cyclePath(apiAreaGraph, cycle);
      report(
        'api/area-cycle',
        apiSrc,
        1,
        `API areas depend on each other in a cycle: ${loop.join(' → ')}. Areas form layers (ADR-0006): move the shared part down.`,
      );
    }
    const modulesRoot = path.join(apiSrc, rules.api.modulesDir);
    if (fs.existsSync(modulesRoot)) {
      for (const entry of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const moduleDir = path.join(modulesRoot, entry.name);
        if (!['index.ts', 'index.js'].some((f) => isFile(path.join(moduleDir, f)))) {
          report(
            'api/module-missing-entry',
            moduleDir,
            1,
            `Feature module ${rules.api.modulesDir}/${entry.name} has no index.ts: export its public service interface there (ADR-0006).`,
          );
        }
      }
    }
  }

  violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
  return { violations, packages: workspace.length, files: fileCount, imports: importCount };
}
