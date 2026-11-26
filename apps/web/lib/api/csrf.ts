/**
 * In-memory CSRF token for the API client (backlog P2-03, ADR-0019, ADR-0014).
 *
 * The API derives the token from the session and hands it out in the bodies of
 * `POST /auth/login` and `GET /auth/session`; the client sends it as `X-CSRF-Token` on every
 * state-changing request. It lives only in this module's memory — never in web storage or a
 * cookie the page could read — so a reload starts without one and the first state-changing
 * request fetches it from `GET /auth/session` (one extra round-trip per page load, then cached).
 *
 * States: `undefined` = unknown (fetch on demand), `null` = signed out (no header is sent),
 * a string = the current session's token.
 */
export interface CsrfTokenStore {
  /** The token, fetching it once when unknown. Never throws: a failed lookup sends no header. */
  get: () => Promise<string | null>;
  /** Remember the token from a sign-in response, or `null` after signing out. */
  remember: (token: string | null) => void;
  /** Forget it (after a 403 `CSRF_FAILED`, e.g. the session changed in another tab). */
  forget: () => void;
}

export function createCsrfTokenStore(load: () => Promise<string | null>): CsrfTokenStore {
  let token: string | null | undefined;
  let pending: Promise<string | null> | undefined;
  let generation = 0;

  return {
    get() {
      if (token !== undefined) return Promise.resolve(token);
      if (!pending) {
        const started = generation;
        pending = load().then(
          (value) => {
            // A remember/forget while loading wins over the (older) loaded value.
            if (started === generation) token = value;
            pending = undefined;
            return value;
          },
          () => {
            pending = undefined;
            return null; // not cached: the next request tries again
          },
        );
      }
      return pending;
    },
    remember(value) {
      generation++;
      pending = undefined;
      token = value;
    },
    forget() {
      generation++;
      pending = undefined;
      token = undefined;
    },
  };
}
