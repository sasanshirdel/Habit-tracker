import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_API_BASE_URL } from './env';

const appDir = join(import.meta.dirname, '..', '..');

/**
 * Fails fast, with the fix, when the production build was not made for this suite: the browser
 * bundle must carry the suite's API address (`build:e2e`), or every API call would go to `/api/v1`
 * on the web origin and the status tests would fail for an unrelated-looking reason.
 */
export default function globalSetup(): void {
  const chunks = join(appDir, '.next', 'static', 'chunks');
  if (!existsSync(join(appDir, '.next', 'BUILD_ID')) || !existsSync(chunks)) {
    throw new Error('No production build: run `pnpm --filter @habit/web build:e2e` first.');
  }
  const baked = readdirSync(chunks, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .some((file) => readFileSync(join(chunks, file), 'utf8').includes(E2E_API_BASE_URL));
  if (!baked) {
    throw new Error(
      `The web build does not point the browser at ${E2E_API_BASE_URL}: rebuild with \`pnpm --filter @habit/web build:e2e\`.`,
    );
  }
}
