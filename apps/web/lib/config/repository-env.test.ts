import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRepositoryEnv, sameOriginApiWarning } from './repository-env';

// Regression for fix/local-dev-api-404: the README's `cp .env.example .env` creates the file at
// the repository root, which Next.js never read, so the browser called /api/v1 on :3000 → 404.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

function parseEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

describe('loadRepositoryEnv', () => {
  let root: string;
  let webDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'habit-web-env-'));
    webDir = path.join(root, 'apps', 'web');
    mkdirSync(webDir, { recursive: true });
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', undefined);
    vi.stubEnv('HABIT_TEST_ONLY', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    delete process.env.HABIT_TEST_ONLY;
    rmSync(root, { recursive: true, force: true });
  });

  it('loads NEXT_PUBLIC_API_BASE_URL from the repository-root .env', () => {
    writeFileSync(
      path.join(root, '.env'),
      'NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1\nHABIT_TEST_ONLY=1\n',
    );
    expect(loadRepositoryEnv(webDir)).toBe(path.join(root, '.env'));
    expect(process.env.NEXT_PUBLIC_API_BASE_URL).toBe('http://localhost:4000/api/v1');
    expect(sameOriginApiWarning()).toBeUndefined();
  });

  it('never overrides a variable that is already set (real env, apps/web/.env*)', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example/api/v1');
    writeFileSync(
      path.join(root, '.env'),
      'NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1\n',
    );
    loadRepositoryEnv(webDir);
    expect(process.env.NEXT_PUBLIC_API_BASE_URL).toBe('https://api.example/api/v1');
  });

  it('is a no-op without a root .env', () => {
    expect(loadRepositoryEnv(webDir)).toBeUndefined();
    expect(process.env.NEXT_PUBLIC_API_BASE_URL).toBeUndefined();
  });
});

describe('sameOriginApiWarning', () => {
  it('warns, naming the variable and the fix, only when the API base is unset', () => {
    expect(sameOriginApiWarning({})).toMatch(/NEXT_PUBLIC_API_BASE_URL is not set.*404/);
    expect(sameOriginApiWarning({ NEXT_PUBLIC_API_BASE_URL: '' })).toBeDefined();
    expect(sameOriginApiWarning({ NEXT_PUBLIC_API_BASE_URL: '/api/v1' })).toBeUndefined();
  });
});

describe('.env.example (the documented local setup)', () => {
  const example = parseEnv(path.join(REPO_ROOT, '.env.example'));

  it('points the web app at the local API it documents, allowed by CORS', () => {
    const apiBase = new URL(example.NEXT_PUBLIC_API_BASE_URL!);
    expect(apiBase.pathname).toBe('/api/v1');
    expect(apiBase.port).toBe(example.API_PORT);
    const webOrigin = new URL(example.WEB_APP_URL!).origin;
    expect(example.CORS_ORIGINS!.split(',').map((o) => o.trim())).toContain(webOrigin);
  });

  it('is loaded by next.config.ts (so `cp .env.example .env` reaches the web build)', () => {
    const config = readFileSync(path.join(REPO_ROOT, 'apps', 'web', 'next.config.ts'), 'utf8');
    expect(config).toMatch(/loadRepositoryEnv\(import\.meta\.dirname\)/);
  });
});
