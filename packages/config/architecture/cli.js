#!/usr/bin/env node
// @ts-check
/**
 * `pnpm check:architecture` (part of `pnpm lint`): check the repository's module boundaries and
 * exit 1 on any violation (backlog P1-15, ADR-0016). Usage: `node cli.js [repository-root]`.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkArchitecture } from './check.js';
import rules from './rules.js';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.resolve(process.argv[2] ?? defaultRoot);

const result = checkArchitecture({ root, rules });

if (result.violations.length === 0) {
  process.stdout.write(
    `Architecture check passed: ${result.packages} workspace packages, ${result.files} files, ${result.imports} imports.\n`,
  );
} else {
  for (const v of result.violations) {
    process.stderr.write(`${v.file}:${v.line}  ${v.rule}  ${v.message}\n`);
  }
  process.stderr.write(
    `\nArchitecture check failed: ${result.violations.length} violation(s). Rules: docs/ARCHITECTURE.md §2.1, ADR-0016.\n`,
  );
  process.exitCode = 1;
}
