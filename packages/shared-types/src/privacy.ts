/**
 * Data export and account deletion contracts (backlog P2-10, ADR-0025). All of them act on the
 * signed-in user's own account only, except the restore confirmation, which needs the emailed
 * link instead of a session.
 */

/**
 * Grace period (interim, ADR-0025): a deleted account can be restored for this many days; after
 * that the account and everything that belongs to it is erased for good, and the email address
 * can be registered again (ADR-0017 holds it until then).
 */
export const ACCOUNT_DELETION_GRACE_DAYS = 30;

/** `format` of every export document; lets tools recognise the file. */
export const USER_DATA_EXPORT_FORMAT = 'habit-tracker.user-data-export';
/** Bumped when a section changes incompatibly (a new section or field is not a new version). */
export const USER_DATA_EXPORT_VERSION = 1;

/**
 * `POST /api/v1/account/export` — a machine-readable copy of everything stored about the signed-in
 * user. Each feature module contributes one section (identity: `account`; habits, goals, … as they
 * are built); sections list rows, never secrets (no password hash, session token or link token).
 */
export interface UserDataExport {
  format: typeof USER_DATA_EXPORT_FORMAT;
  version: typeof USER_DATA_EXPORT_VERSION;
  /** When the copy was made (ISO 8601, UTC). */
  exportedAt: string;
  /** One entry per contributing module, keyed by section name. */
  sections: Record<string, unknown>;
}

/** `POST /api/v1/account/deletion` — the current password confirms that the owner is present. */
export interface AccountDeletionRequest {
  password: string;
}

/** `POST /api/v1/account/deletion` — 202. Every session has ended; the cookie is cleared. */
export interface AccountDeletionResponse {
  status: 'deletion-scheduled';
  /** When the account is erased for good unless restored before (ISO 8601, UTC). */
  purgeAfter: string;
}

/** `POST /api/v1/auth/account-restore` — the token from the "account deleted" email. */
export interface AccountRestoreRequest {
  token: string;
}

/** `POST /api/v1/auth/account-restore` — 200. Does not sign in. */
export interface AccountRestoreResponse {
  status: 'restored';
}
