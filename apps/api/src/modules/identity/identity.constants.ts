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
