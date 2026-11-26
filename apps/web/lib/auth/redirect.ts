import { isLocale } from '@habit/localization';
import { appHomeHref, isActiveSection, sections } from '@/lib/navigation/sections';

/**
 * The `next` parameter of the sign-in and sign-up pages (backlog P2-09): where to go after signing
 * in. It comes from the URL, so anyone can craft it — an **open redirect** risk (a link to our
 * sign-in page that sends the user to `https://evil.example` afterwards). It is therefore only
 * honoured when it is a path **inside the signed-in app**:
 *
 * - a string of at most {@link NEXT_MAX_LENGTH} characters with no whitespace or control
 *   characters (browsers strip tabs/newlines from URLs, so `/\t/evil.example` would become
 *   `//evil.example`) and no backslash (`/\evil.example` is `//evil.example` to WHATWG parsers);
 * - starting with exactly one `/` (never `//host` or `scheme:`), and still on our origin after
 *   WHATWG URL parsing;
 * - whose path is one of the app's sections or below one (`/habits`, `/habits/123`) — an
 *   allow-list, so not even our own sign-in, API or unknown paths qualify.
 *
 * A leading locale segment (`/fa/habits`) is dropped: the locale-aware router adds the current
 * one. Anything else yields `null` and callers fall back to {@link appHomeHref}.
 */
export const NEXT_PARAM = 'next';
export const NEXT_MAX_LENGTH = 512;

const BASE = 'https://app.invalid';
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN = /[\s\u0000-\u001f\u007f\\]/u;

export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > NEXT_MAX_LENGTH) return null;
  if (FORBIDDEN.test(raw) || !raw.startsWith('/') || raw.startsWith('//')) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  let pathname = url.pathname;
  const first = pathname.split('/')[1] ?? '';
  if (isLocale(first)) pathname = pathname.slice(first.length + 1) || '/';
  if (!sections.some((section) => isActiveSection(pathname, section.href))) return null;
  return `${pathname}${url.search}${url.hash}`;
}

/** Where to go after signing in: the safe `next` or the app's home. */
export function afterSignInPath(raw: string | null | undefined): string {
  return safeNextPath(raw) ?? appHomeHref;
}

/** The sign-in page (locale-less), carrying `next` when it is safe. */
export function signInHref(next?: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `/auth/sign-in?${NEXT_PARAM}=${encodeURIComponent(safe)}` : '/auth/sign-in';
}

/** The sign-up page (locale-less), carrying `next` when it is safe. */
export function signUpHref(next?: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `/auth/sign-up?${NEXT_PARAM}=${encodeURIComponent(safe)}` : '/auth/sign-up';
}
