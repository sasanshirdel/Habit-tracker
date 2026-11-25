import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    baseUrl: string;
  }
}

const appDir = join(import.meta.dirname, '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no free port')),
      );
    });
  });
}

async function waitUntilUp(url: string, child: ChildProcess, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode}`);
    try {
      await fetch(url, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`next start did not answer at ${url} within ${timeoutMs} ms`);
}

/** Starts the built app with `next start` on a free port; stops it after the run. */
export default async function setup(project: TestProject) {
  if (!existsSync(join(appDir, '.next', 'BUILD_ID'))) {
    throw new Error('No production build: run `pnpm --filter @habit/web build` first.');
  }
  const port = await freePort();
  const nextBin = join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const output: string[] = [];
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: appDir,
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntilUp(baseUrl, child);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${(error as Error).message}\n${output.join('')}`, { cause: error });
  }
  project.provide('baseUrl', baseUrl);

  return async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  };
}
