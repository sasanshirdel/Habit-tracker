import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setUnauthenticatedListener } from './api';
import { SESSION_PATH } from './config';

// Backlog P2-09 (ADR-0027): every 401 of the app client reaches the session re-check — except the
// session lookup's own, which is the answer "signed out" (reporting it would loop).

function unauthenticated() {
  return new Response(
    JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Not signed in.' } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api: session-ended hook', () => {
  it('tells the listener about a 401 on any request but the session lookup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => unauthenticated()),
    );
    const listener = vi.fn();
    const remove = setUnauthenticatedListener(listener);

    await expect(api.get(SESSION_PATH)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(listener).not.toHaveBeenCalled();

    await expect(api.get('/account/profile')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(listener).toHaveBeenCalledTimes(1);

    // Removed: later 401s go nowhere; removing a replaced listener keeps the new one.
    remove();
    await expect(api.get('/account/sessions')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(listener).toHaveBeenCalledTimes(1);
    const next = vi.fn();
    setUnauthenticatedListener(next);
    remove();
    await expect(api.get('/account/sessions')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
