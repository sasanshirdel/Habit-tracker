import type { IncomingMessage } from 'node:http';
import type { ClientBrowser, ClientDescription, ClientDevice, ClientOs } from '@habit/shared-types';

/**
 * Coarse client description for sessions and security events (backlog P2-08, ADR-0023).
 *
 * The `User-Agent` header is reduced on arrival to three families — browser, operating system,
 * device class — and then discarded: the raw string, versions and the IP address are never stored,
 * logged or returned. The result helps a user recognise "Firefox on Android" in their device list;
 * it is **not** a security signal (any client can send any header) and never used for decisions.
 *
 * In-repo, no dependency (ua-parser-js and similar were not needed for three coarse fields).
 * Anything unrecognised is `unknown`. Order matters: Edge, Opera and Samsung Internet also say
 * "Chrome", Chrome on iOS says "Safari", and so on.
 */

/** Longer headers are cut before matching (cheap, bounded regex work on hostile input). */
const MAX_USER_AGENT_LENGTH = 512;

export const UNKNOWN_CLIENT: ClientDescription = Object.freeze({
  browser: 'unknown',
  os: 'unknown',
  device: 'unknown',
});

function browserOf(ua: string): ClientBrowser {
  if (/\b(Edg|EdgA|EdgiOS|Edge)\//.test(ua)) return 'edge';
  if (/\b(OPR|OPiOS|Opera)\//.test(ua)) return 'opera';
  if (/\bSamsungBrowser\//.test(ua)) return 'samsung_internet';
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'firefox';
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return 'chrome';
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua) || /\b(iPhone|iPad|iPod)\b.*\bMobile\//.test(ua)) {
    return 'safari';
  }
  return 'unknown';
}

function osOf(ua: string): ClientOs {
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'ios';
  if (/\bAndroid\b/.test(ua)) return 'android';
  if (/\bCrOS\b/.test(ua)) return 'chromeos';
  if (/\bWindows\b/.test(ua)) return 'windows';
  if (/\b(Macintosh|Mac OS X)\b/.test(ua)) return 'macos';
  if (/\b(Linux|X11)\b/.test(ua)) return 'linux';
  return 'unknown';
}

function deviceOf(ua: string, os: ClientOs): ClientDevice {
  if (/\biPad\b|\bTablet\b/.test(ua)) return 'tablet';
  if (os === 'android') return /\bMobile\b/.test(ua) ? 'mobile' : 'tablet';
  if (/\b(iPhone|iPod)\b|\bMobi/.test(ua)) return 'mobile';
  if (os === 'windows' || os === 'macos' || os === 'linux' || os === 'chromeos') return 'desktop';
  return 'unknown';
}

/** Classifies a `User-Agent` value. Missing, empty or unrecognised parts → `unknown`. */
export function describeUserAgent(userAgent: string | undefined | null): ClientDescription {
  if (typeof userAgent !== 'string' || userAgent.trim() === '') return UNKNOWN_CLIENT;
  const ua = userAgent.slice(0, MAX_USER_AGENT_LENGTH);
  const os = osOf(ua);
  const browser = browserOf(ua);
  const device = deviceOf(ua, os);
  return { browser, os, device };
}

/** The coarse description of the client that sent `req`. */
export function describeClient(req: IncomingMessage): ClientDescription {
  const header = req.headers['user-agent'];
  return describeUserAgent(Array.isArray(header) ? header[0] : header);
}

/** Column values for `user_sessions` / `user_security_events`. */
export function clientColumns(client: ClientDescription): {
  clientBrowser: ClientBrowser;
  clientOs: ClientOs;
  clientDevice: ClientDevice;
} {
  return { clientBrowser: client.browser, clientOs: client.os, clientDevice: client.device };
}

/** The API shape from stored columns. */
export function clientFromColumns(row: {
  clientBrowser: ClientBrowser;
  clientOs: ClientOs;
  clientDevice: ClientDevice;
}): ClientDescription {
  return { browser: row.clientBrowser, os: row.clientOs, device: row.clientDevice };
}
