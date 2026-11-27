/**
 * Reading the verification token from the emailed link (backlog P2-04, ADR-0021). The link is
 * `/{locale}/auth/verify-email#token=<43 base64url characters>`: the token sits in the URL
 * **fragment**, which browsers never send to any server (no access log, no `Referer`). The page
 * reads it once, removes it from the address bar, keeps it in memory only, and posts it when the
 * user presses "Confirm" — opening the link alone changes nothing (mail scanners open links).
 */

/** Shape of a token the API issues (32 random bytes, base64url without padding). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The token in a location hash (`#token=…`), or `null` when there is none or it is malformed. */
export function verificationTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '' || raw.length > 256) return null;
  const token = new URLSearchParams(raw).get('token');
  return token !== null && TOKEN.test(token) ? token : null;
}

/** Removes the fragment from the address bar without navigating (keeps the router's state). */
export function removeHashFromAddressBar(): void {
  if (!window.location.hash) return;
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
}
