import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const apiRoot = resolve(import.meta.dirname, '../..');

/** Runs the Prisma CLI exactly as developers/CI do, against `databaseUrl`. Never throws. */
export function prismaCli(args: string[], databaseUrl: string): { code: number; output: string } {
  try {
    const output = execFileSync(resolve(apiRoot, 'node_modules/.bin/prisma'), args, {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}
