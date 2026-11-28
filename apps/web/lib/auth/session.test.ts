import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { recheckSession, sessionQueryKey, watchSessionExpiry, type SessionState } from './session';

// Backlog P2-09 (ADR-0027): a 401 anywhere re-checks the session once; signed out → the cached
// user data goes and the state says why, so the gate can send the user to sign-in and back.

const http = vi.hoisted(() => ({
  get: vi.fn(),
  remember: vi.fn(),
  listener: undefined as undefined | ((error: unknown) => void),
}));
vi.mock('@/lib/api/api', () => ({
  api: { get: http.get },
  csrfTokens: { remember: http.remember, get: vi.fn(), forget: vi.fn() },
  setUnauthenticatedListener: (listener: (error: unknown) => void) => {
    http.listener = listener;
    return () => {};
  },
}));

const USER = { id: 'u1', email: 'sara@example.com', emailVerified: true };
const signedIn: SessionState = { status: 'signed-in', user: USER };
const unauthenticated = () => new ApiError('UNAUTHENTICATED', 'no session', { status: 401 });

function setup(initial?: SessionState) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (initial) queryClient.setQueryData(sessionQueryKey, initial);
  queryClient.setQueryData(['account', 'profile'], { displayName: 'Sara' });
  return queryClient;
}

beforeEach(() => {
  http.get.mockReset();
  http.remember.mockReset();
});

describe('recheckSession', () => {
  it('signed out now: drops user data, forgets the CSRF token, marks the session expired', async () => {
    http.get.mockRejectedValue(unauthenticated());
    const queryClient = setup(signedIn);
    await recheckSession(queryClient);
    expect(http.get).toHaveBeenCalledWith('/auth/session', expect.anything());
    expect(queryClient.getQueryData(sessionQueryKey)).toEqual({
      status: 'signed-out',
      reason: 'expired',
    });
    expect(queryClient.getQueryData(['account', 'profile'])).toBeUndefined();
    expect(http.remember).toHaveBeenCalledWith(null);
  });

  it('shares one session lookup between concurrent 401s', async () => {
    let answer!: (value: unknown) => void;
    http.get.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const queryClient = setup(signedIn);
    const checks = [1, 2, 3, 4, 5].map(() => recheckSession(queryClient));
    answer({ user: USER, csrfToken: 't' });
    await Promise.all(checks);
    expect(http.get).toHaveBeenCalledTimes(1);
    // A later 401 checks again (nothing is cached between bursts).
    http.get.mockResolvedValue({ user: USER, csrfToken: 't' });
    await recheckSession(queryClient);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  it('still signed in: nothing changes (the 401 was about something else)', async () => {
    http.get.mockResolvedValue({ user: USER, csrfToken: 't' });
    const queryClient = setup(signedIn);
    await recheckSession(queryClient);
    expect(queryClient.getQueryData(sessionQueryKey)).toEqual(signedIn);
    expect(queryClient.getQueryData(['account', 'profile'])).toEqual({ displayName: 'Sara' });
  });

  it('a failed check keeps the state; a tab that was never signed in is just signed out', async () => {
    http.get.mockRejectedValue(new ApiError('NETWORK_ERROR', 'offline'));
    const queryClient = setup(signedIn);
    await expect(recheckSession(queryClient)).resolves.toBeUndefined();
    expect(queryClient.getQueryData(sessionQueryKey)).toEqual(signedIn);

    http.get.mockRejectedValue(unauthenticated());
    const fresh = setup();
    await recheckSession(fresh);
    expect(fresh.getQueryData(sessionQueryKey)).toEqual({ status: 'signed-out' });
  });
});

describe('watchSessionExpiry', () => {
  it("connects the API client's 401 hook to the re-check", async () => {
    http.get.mockRejectedValue(unauthenticated());
    const queryClient = setup(signedIn);
    watchSessionExpiry(queryClient);
    expect(http.listener).toBeTypeOf('function');
    http.listener!(unauthenticated());
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(sessionQueryKey)).toEqual({
        status: 'signed-out',
        reason: 'expired',
      }),
    );
  });
});
