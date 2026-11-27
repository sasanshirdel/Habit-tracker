/**
 * Limits shared by the identity tables (P2-01) and the validation that P2-02+ adds at the API edge.
 * The database enforces the same bounds with CHECK constraints (migration `…_identity`), so these
 * values and the migration must change together.
 */
export const IDENTITY_LIMITS = {
  /** RFC 5321 path limit. `users_email_check`. */
  emailMaxLength: 254,
  /** `user_profiles_display_name_check`. */
  displayNameMaxLength: 100,
  /** `user_preferences_timezone_check` (longest IANA name today is 32). */
  timezoneMaxLength: 64,
} as const;

/** Prefix every stored password hash must carry (`user_password_credentials_password_hash_check`). */
export const PASSWORD_HASH_PREFIX = '$argon2id$v=19$';

/**
 * Customer session cookie (ADR-0005, ADR-0018). The `__Host-` prefix makes browsers accept it only
 * with `Secure`, `Path=/` and no `Domain`, so a sibling subdomain cannot set or overwrite it.
 */
export const SESSION_COOKIE_NAME = '__Host-session';

/**
 * Session lifetimes (interim values, ADR-0018 open decisions): a session ends 30 days after
 * sign-in at the latest (absolute; also the cookie's `Max-Age`) and after 7 days without use
 * (idle, from `last_used_at`).
 */
export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
/** `last_used_at` is written at most this often per session (not on every request). */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
