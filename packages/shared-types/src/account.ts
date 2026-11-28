/**
 * Session management and security activity contracts (backlog P2-08, ADR-0023). All routes are for
 * the signed-in user only and return only that user's data.
 */
import type { Paginated } from './pagination.js';

/** Browser family, derived from the `User-Agent` at sign-in (never the raw header or a version). */
export const CLIENT_BROWSERS = [
  'chrome',
  'edge',
  'firefox',
  'safari',
  'opera',
  'samsung_internet',
  'unknown',
] as const;
export type ClientBrowser = (typeof CLIENT_BROWSERS)[number];

/** Operating-system family. */
export const CLIENT_OSES = [
  'windows',
  'macos',
  'ios',
  'android',
  'linux',
  'chromeos',
  'unknown',
] as const;
export type ClientOs = (typeof CLIENT_OSES)[number];

/** Device class. */
export const CLIENT_DEVICES = ['desktop', 'mobile', 'tablet', 'unknown'] as const;
export type ClientDevice = (typeof CLIENT_DEVICES)[number];

/**
 * Coarse description of the client a session or event came from. Deliberately imprecise: no IP
 * address, location, raw user agent or version is stored or returned (ADR-0023).
 */
export interface ClientDescription {
  browser: ClientBrowser;
  os: ClientOs;
  device: ClientDevice;
}

/** One active session of the signed-in user (`GET /api/v1/account/sessions`). */
export interface AccountSession {
  /** Opaque session id (UUIDv7) — not the session token. */
  id: string;
  /** `true` for the session that made this request. */
  current: boolean;
  client: ClientDescription;
  /** When the user signed in (ISO 8601, UTC). */
  createdAt: string;
  /** Last request seen, accurate to about a minute (ISO 8601, UTC). */
  lastActiveAt: string;
  /** When the session ends at the latest, even if used (ISO 8601, UTC). */
  expiresAt: string;
}

/** `GET /api/v1/account/sessions` — active sessions, newest sign-in first. */
export type AccountSessionList = Paginated<AccountSession>;

/** `POST /api/v1/account/sessions/revoke-others` — 200. */
export interface RevokeOtherSessionsResponse {
  /** How many sessions were ended (0 when this was the only one). */
  revoked: number;
}

/** What a security event records. */
export const SECURITY_EVENT_TYPES = [
  'sign_in',
  'sign_out',
  'signed_out_everywhere',
  'signed_out_other_sessions',
  'session_revoked',
  'password_reset',
  'email_verified',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

/** One entry of the signed-in user's security activity. */
export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  /** ISO 8601, UTC. */
  occurredAt: string;
  /** The client that caused the event, as coarse as {@link ClientDescription}. */
  client: ClientDescription;
}

/** `GET /api/v1/account/security-events` — newest first, within the retention window. */
export type SecurityEventList = Paginated<SecurityEvent>;

/**
 * Retention (interim, ADR-0023): security events are kept and shown for this many days; ended
 * sessions are deleted this many days after they ended.
 */
export const SECURITY_EVENT_RETENTION_DAYS = 180;
export const ENDED_SESSION_RETENTION_DAYS = 30;
