import { describe, expect, it, vi } from 'vitest';
import { createCsrfTokenStore } from './csrf';

// Backlog P2-03 (ADR-0019): the in-memory CSRF token of the web client.
describe('createCsrfTokenStore', () => {
  it('fetches once on demand and caches the token (or the signed-out null)', async () => {
    const load = vi.fn(() => Promise.resolve('t1'));
    const store = createCsrfTokenStore(load);
    const [a, b] = await Promise.all([store.get(), store.get()]);
    expect([a, b]).toEqual(['t1', 't1']);
    await store.get();
    expect(load).toHaveBeenCalledTimes(1);

    const signedOut = createCsrfTokenStore(() => Promise.resolve(null));
    expect(await signedOut.get()).toBeNull();
  });

  it('remember() sets the token from sign-in without a lookup; forget() refetches', async () => {
    const load = vi.fn(() => Promise.resolve('from-session'));
    const store = createCsrfTokenStore(load);
    store.remember('from-login');
    expect(await store.get()).toBe('from-login');
    expect(load).not.toHaveBeenCalled();
    store.forget();
    expect(await store.get()).toBe('from-session');
    store.remember(null);
    expect(await store.get()).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a failed lookup yields no token and is not cached', async () => {
    const load = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('later');
    const store = createCsrfTokenStore(load);
    expect(await store.get()).toBeNull();
    expect(await store.get()).toBe('later');
  });

  it('a remember() during a lookup wins over the older loaded value', async () => {
    let resolve!: (v: string) => void;
    const store = createCsrfTokenStore(() => new Promise<string>((r) => (resolve = r)));
    const pending = store.get();
    store.remember('newer');
    resolve('older');
    await pending;
    expect(await store.get()).toBe('newer');
  });
});
