import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildUrl, createApiClient } from './client';
import { ApiError, parseRetryAfter } from './errors';

const BASE = 'https://api.example.test/api/v1';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function envelope(code: string, details?: unknown, requestId = 'req-123') {
  return { error: { code, message: `dev message for ${code}`, details, requestId } };
}

/** A fetch double that records its calls and answers with `respond`. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('buildUrl', () => {
  it('joins base and path and encodes the query, skipping null/undefined, repeating arrays', () => {
    expect(buildUrl(`${BASE}/`, '/habits', { limit: 20, cursor: undefined, q: 'a b&c' })).toBe(
      `${BASE}/habits?limit=20&q=a+b%26c`,
    );
    expect(buildUrl(BASE, '/tasks', { tag: ['x', 'y'], done: false, none: null })).toBe(
      `${BASE}/tasks?tag=x&tag=y&done=false`,
    );
    expect(buildUrl('/api/v1', '/health')).toBe('/api/v1/health');
  });

  it.each(['https://evil.test/x', '//evil.test/x', 'health', '/\\evil.test'])(
    'refuses a path that could leave the API: %s',
    (path) => {
      expect(() => buildUrl(BASE, path)).toThrow(TypeError);
    },
  );
});

describe('requests', () => {
  it('sends cookies (credentials: include), asks for JSON and bypasses the HTTP cache', async () => {
    const { fetch, calls } = fakeFetch(() => json({ status: 'ok' }));
    const api = createApiClient({ baseUrl: BASE, fetch });
    await expect(api.get('/health')).resolves.toEqual({ status: 'ok' });
    const [call] = calls;
    expect(call?.url).toBe(`${BASE}/health`);
    expect(call?.init.method).toBe('GET');
    expect(call?.init.credentials).toBe('include');
    expect(call?.init.cache).toBe('no-store');
    expect(new Headers(call?.init.headers).get('accept')).toBe('application/json');
    expect(call?.init.body).toBeUndefined();
  });

  it('sends JSON bodies', async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: '1' }, 201));
    const api = createApiClient({ baseUrl: BASE, fetch });
    await expect(api.post('/habits', { name: 'مطالعه' })).resolves.toEqual({ id: '1' });
    expect(calls[0]?.init.body).toBe('{"name":"مطالعه"}');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
  });

  it('adds the CSRF header to state-changing requests only, and only when there is a token', async () => {
    let token: string | undefined = 'csrf-token';
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const api = createApiClient({
      baseUrl: BASE,
      fetch,
      csrf: { headerName: 'x-csrf-token', getToken: () => token },
    });
    await api.get('/a');
    await api.post('/a');
    await api.patch('/a', {});
    await api.delete('/a');
    token = undefined;
    await api.put('/a', {});
    const sent = calls.map((c) => new Headers(c.init.headers).get('x-csrf-token'));
    expect(sent).toEqual([null, 'csrf-token', 'csrf-token', 'csrf-token', null]);
  });

  it('resolves 204 No Content to undefined', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(createApiClient({ baseUrl: BASE, fetch }).delete('/a')).resolves.toBeUndefined();
  });
});

describe('errors', () => {
  it('turns the error envelope into an ApiError with code, status, requestId and details', async () => {
    const issues = [{ field: 'body.name', code: 'too_small', message: 'x' }];
    const { fetch } = fakeFetch(() => json(envelope('VALIDATION_FAILED', { issues }), 422));
    const error = await rejection(createApiClient({ baseUrl: BASE, fetch }).post('/a', {}));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      requestId: 'req-123',
      details: { issues },
    });
  });

  it('takes the RATE_LIMITED wait from details, else from Retry-After', async () => {
    const details = { retryAfterSeconds: 42, policy: 'auth' };
    let res = () => json(envelope('RATE_LIMITED', details), 429, { 'retry-after': '42' });
    const api = createApiClient({ baseUrl: BASE, fetch: fakeFetch(() => res()).fetch });
    expect(await rejection(api.get('/a'))).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
    });
    // A proxy's 429 without the envelope: code from the status, wait from the header.
    res = () =>
      new Response('<html>slow down</html>', {
        status: 429,
        headers: { 'content-type': 'text/html', 'retry-after': '7', 'x-request-id': 'edge-1' },
      });
    expect(await rejection(api.get('/a'))).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterSeconds: 7,
      requestId: 'edge-1',
    });
  });

  it.each([
    [502, 'INTERNAL_ERROR'],
    [503, 'SERVICE_UNAVAILABLE'],
    [404, 'NOT_FOUND'],
    [401, 'UNAUTHENTICATED'],
    [418, 'BAD_REQUEST'],
  ])('maps an envelope-less %i to %s', async (status, code) => {
    const { fetch } = fakeFetch(() => new Response('', { status }));
    expect(await rejection(createApiClient({ baseUrl: BASE, fetch }).get('/a'))).toMatchObject({
      code,
      status,
    });
  });

  it('ignores an unknown code in the envelope and uses the status', async () => {
    const { fetch } = fakeFetch(() => json(envelope('SOMETHING_NEW'), 409));
    expect(await rejection(createApiClient({ baseUrl: BASE, fetch }).get('/a'))).toMatchObject({
      code: 'CONFLICT',
      requestId: 'req-123',
    });
  });

  it('reports a non-JSON or unparsable success as INVALID_RESPONSE', async () => {
    const html = fakeFetch(
      () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    );
    expect(
      await rejection(createApiClient({ baseUrl: BASE, fetch: html.fetch }).get('/a')),
    ).toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 200,
    });
    const broken = fakeFetch(
      () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    );
    expect(
      await rejection(createApiClient({ baseUrl: BASE, fetch: broken.fetch }).get('/a')),
    ).toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('reports a failed fetch as NETWORK_ERROR', async () => {
    const { fetch } = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const error = await rejection(createApiClient({ baseUrl: BASE, fetch }).get('/a'));
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: undefined });
    expect((error as ApiError).cause).toBeInstanceOf(TypeError);
  });

  /** Never answers; rejects like fetch when its signal aborts. */
  const hangingFetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

  it('reports a slow API as TIMEOUT', async () => {
    const { fetch } = fakeFetch(hangingFetch);
    const api = createApiClient({ baseUrl: BASE, fetch, timeoutMs: 20 });
    expect(await rejection(api.get('/a'))).toMatchObject({ code: 'TIMEOUT' });
  });

  it('rethrows a cancellation by the caller as is (TanStack Query cancels quietly)', async () => {
    const { fetch } = fakeFetch(hangingFetch);
    const controller = new AbortController();
    const pending = createApiClient({ baseUrl: BASE, fetch }).get('/a', {
      signal: controller.signal,
    });
    controller.abort();
    const error = await rejection(pending);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as DOMException).name).toBe('AbortError');
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    const now = Date.UTC(2026, 10, 25, 12, 0, 0);
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now)).toBe(30);
    expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now - 400)).toBe(31);
    expect(parseRetryAfter(new Date(now - 5_000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('no tokens in web storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never touches localStorage or sessionStorage', async () => {
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw new Error('web storage must not be used by the API client');
        },
      },
    );
    vi.stubGlobal('localStorage', forbidden);
    vi.stubGlobal('sessionStorage', forbidden);
    const { fetch } = fakeFetch((url) =>
      url.endsWith('/fail') ? json(envelope('UNAUTHENTICATED'), 401) : json({ ok: true }),
    );
    const api = createApiClient({
      baseUrl: BASE,
      fetch,
      csrf: { headerName: 'x-csrf-token', getToken: () => 't' },
    });
    await api.get('/ok');
    await api.post('/ok', {});
    expect(await rejection(api.get('/fail'))).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('over real HTTP (an API-shaped server)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const requestId = 'srv-req-1';
      if (req.url === '/api/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': requestId });
        res.end(
          JSON.stringify({
            status: 'ok',
            uptimeSeconds: 61,
            timestamp: '2026-11-25T00:00:00.000Z',
          }),
        );
        return;
      }
      if (req.url === '/api/v1/limited') {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '9',
          'x-request-id': requestId,
        });
        res.end(
          JSON.stringify(
            envelope('RATE_LIMITED', { retryAfterSeconds: 9, policy: 'default' }, requestId),
          ),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json', 'x-request-id': requestId });
      res.end(JSON.stringify(envelope('NOT_FOUND', undefined, requestId)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('reads success, RATE_LIMITED and NOT_FOUND responses through the global fetch', async () => {
    const api = createApiClient({ baseUrl: base });
    await expect(api.get('/health')).resolves.toMatchObject({ status: 'ok', uptimeSeconds: 61 });
    expect(await rejection(api.get('/limited'))).toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterSeconds: 9,
      requestId: 'srv-req-1',
    });
    expect(await rejection(api.get('/nope'))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});
