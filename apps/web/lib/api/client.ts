import type { ApiErrorBody } from '@habit/shared-types';
import { ApiError, codeFromResponse, parseRetryAfter } from './errors';

/**
 * Typed HTTP client for the Habit API (backlog P1-12, ADR-0009 conventions).
 *
 * - **Cookies, never tokens in storage:** every request is sent with `credentials: 'include'`,
 *   so the session cookie (Phase 2, `HttpOnly`) travels with it; the client never reads or
 *   writes `localStorage`/`sessionStorage` (a test asserts it).
 * - **CSRF header:** for state-changing methods the client adds the header returned by
 *   `csrf.getToken()` under `csrf.headerName`. P2-03 decides the token's source and header name
 *   (and adds it to the API's CORS allow-list); until then no CSRF option is configured.
 * - **Errors:** a non-2xx response becomes an `ApiError` with the envelope's stable `code`,
 *   `requestId`, `details` and `retryAfterSeconds`; envelope-less responses (e.g. a proxy's 502)
 *   get the code for their status. No response → `NETWORK_ERROR`; too slow → `TIMEOUT`;
 *   unparsable → `INVALID_RESPONSE`. Aborts by the caller rethrow the `AbortError`.
 * - **Same API only:** paths are relative to `baseUrl`; an absolute URL or `//host` path is
 *   rejected, so credentials are never sent to another origin by mistake.
 */

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const SAFE_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD']);

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: HttpMethod;
  /** Appended as a query string; `null`/`undefined` values are skipped. */
  query?: Record<string, QueryValue | readonly QueryValue[]>;
  /** Sent as JSON. */
  body?: unknown;
  /** Cancels the request (TanStack Query passes one to every query function). */
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface CsrfOptions {
  headerName: string;
  getToken: () => string | null | undefined;
}

export interface ApiClientOptions {
  /** `NEXT_PUBLIC_API_BASE_URL`, e.g. `https://api.example.com/api/v1` or `/api/v1`. */
  baseUrl: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 15 s). */
  timeoutMs?: number;
  csrf?: CsrfOptions;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
  post<T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<T>;
  put<T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<T>;
  patch<T>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<T>;
  delete<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T>;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Joins `baseUrl` and `path` and appends `query`. Throws on a path that could leave the API. */
export function buildUrl(baseUrl: string, path: string, query?: RequestOptions['query']): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new TypeError(`API paths must be relative to the API base URL, got "${path}"`);
  }
  let url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, raw] of Object.entries(query)) {
      const values: readonly QueryValue[] = Array.isArray(raw) ? raw : [raw as QueryValue];
      for (const value of values) {
        if (value !== null && value !== undefined) params.append(key, String(value));
      }
    }
    const search = params.toString();
    if (search) url += `${url.includes('?') ? '&' : '?'}${search}`;
  }
  return url;
}

function isEnvelope(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return !!error && typeof error === 'object';
}

function isJson(response: Response): boolean {
  return /\bjson\b/i.test(response.headers.get('content-type') ?? '');
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown;
  if (isJson(response)) {
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
  }
  const envelope = isEnvelope(body) ? body.error : undefined;
  const code = codeFromResponse(response.status, envelope?.code);
  const requestId =
    (typeof envelope?.requestId === 'string' ? envelope.requestId : undefined) ??
    response.headers.get('x-request-id') ??
    undefined;
  const details = envelope?.details;
  const fromDetails =
    code === 'RATE_LIMITED' &&
    details &&
    typeof details === 'object' &&
    typeof (details as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
      ? (details as { retryAfterSeconds: number }).retryAfterSeconds
      : undefined;
  return new ApiError(
    code,
    typeof envelope?.message === 'string' ? envelope.message : `HTTP ${response.status}`,
    {
      status: response.status,
      requestId,
      details,
      retryAfterSeconds: fromDetails ?? parseRetryAfter(response.headers.get('retry-after')),
    },
  );
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const url = buildUrl(options.baseUrl, path, init.query);
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.body);
    }
    if (!SAFE_METHODS.has(method) && options.csrf) {
      const token = options.csrf.getToken();
      if (token) headers.set(options.csrf.headerName, token);
    }

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const doFetch = options.fetch ?? globalThis.fetch;

    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        body,
        signal,
        credentials: 'include',
        // Responses are per user once sessions exist; TanStack Query is the cache.
        cache: 'no-store',
      });
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      if (timeout.aborted) {
        throw new ApiError('TIMEOUT', `No response within ${timeoutMs} ms`, { cause: error });
      }
      throw new ApiError('NETWORK_ERROR', 'The request did not reach the API', { cause: error });
    }

    if (!response.ok) throw await errorFromResponse(response);
    if (response.status === 204 || method === 'HEAD') return undefined as T;
    if (!isJson(response)) {
      throw new ApiError('INVALID_RESPONSE', 'Expected a JSON response', {
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? undefined,
      });
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ApiError('INVALID_RESPONSE', 'The response body is not valid JSON', {
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? undefined,
        cause: error,
      });
    }
  }

  return {
    request,
    get: (path, init) => request(path, { ...init, method: 'GET' }),
    post: (path, body, init) => request(path, { ...init, method: 'POST', body }),
    put: (path, body, init) => request(path, { ...init, method: 'PUT', body }),
    patch: (path, body, init) => request(path, { ...init, method: 'PATCH', body }),
    delete: (path, init) => request(path, { ...init, method: 'DELETE' }),
  };
}
