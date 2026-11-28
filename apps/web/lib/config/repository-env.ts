import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads the repository-root `.env` into `process.env` for the web app (local development).
 *
 * Next.js reads `.env*` files only from the app's own directory (`apps/web`), but the documented
 * setup is one `.env` at the repository root, copied from `.env.example` — the file the API, the
 * worker and Prisma already read. Without this, `NEXT_PUBLIC_API_BASE_URL` from that file never
 * reached the web build: the browser fell back to `/api/v1` on the web origin and every API request
 * answered 404 (fix/local-dev-api-404).
 *
 * Precedence is unchanged for everything that was already set: real environment variables and
 * `apps/web/.env*` (loaded by Next.js before `next.config.ts` runs) win, because
 * `process.loadEnvFile` never overwrites a variable that is already defined. Missing file = no-op
 * (CI and deployments set real variables).
 *
 * Only Node built-ins: this runs from `next.config.ts`, never in the browser.
 *
 * @param webDir the `apps/web` directory
 * @returns the file that was loaded, if any
 */
export function loadRepositoryEnv(webDir: string): string | undefined {
  const file = path.resolve(webDir, '..', '..', '.env');
  if (!existsSync(file)) return undefined;
  process.loadEnvFile(file);
  return file;
}

/**
 * The startup warning for a web app that will call the API on its own origin (`/api/v1`): correct
 * only behind a reverse proxy that routes `/api` to the API (ADR-0014), and the reason for a
 * "404 on every request" otherwise. Returns nothing when `NEXT_PUBLIC_API_BASE_URL` is set.
 */
export function sameOriginApiWarning(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.NEXT_PUBLIC_API_BASE_URL) return undefined;
  return (
    '[web] NEXT_PUBLIC_API_BASE_URL is not set: the browser will call /api/v1 on the web origin, ' +
    'which answers 404 unless a reverse proxy routes /api to the API. For local development set ' +
    'NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1 in the repository-root .env ' +
    '(cp .env.example .env) and restart the web app.'
  );
}
