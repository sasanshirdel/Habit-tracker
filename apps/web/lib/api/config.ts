/**
 * Where the browser reaches the API (backlog P1-12). `NEXT_PUBLIC_API_BASE_URL` is inlined at
 * build time and also feeds the CSP's `connect-src` (proxy.ts). Without it the client calls
 * `/api/v1` on the web origin — which only works behind a reverse proxy that routes `/api` to the
 * API; set the variable in every other deployment.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || '/api/v1';

/**
 * Where the browser learns whether it is signed in (P2-03, ADR-0019). A 401 from it means "signed
 * out", so it is the one request whose 401 does not trigger a session re-check (ADR-0027).
 */
export const SESSION_PATH = '/auth/session';
