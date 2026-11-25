import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque secret tokens for sessions and emailed single-use links (backlog P2-01, ADR-0005,
 * ADR-0017).
 *
 * - A token is 32 random bytes from the OS CSPRNG (256 bits), encoded as 43 base64url characters.
 *   It is handed to the client exactly once (cookie or link) and never stored or logged.
 * - The database keeps only `SHA-256(token)` (32 bytes, `token_hash`, unique). A fast hash is the
 *   right tool here: the input is uniformly random with 256 bits of entropy, so there is nothing
 *   to brute-force and no salt or slow KDF is needed (unlike passwords, which use Argon2id).
 * - Lookups go by hash. Malformed input is rejected before hashing, so garbage never reaches a
 *   query, and any comparison of hashes the caller does in memory must use
 *   {@link secretTokenHashesEqual} (constant time).
 */

/** Random bytes per token (256 bits). */
export const SECRET_TOKEN_BYTES = 32;
/** Length of the base64url (no padding) encoding of {@link SECRET_TOKEN_BYTES} bytes. */
export const SECRET_TOKEN_LENGTH = 43;
/** Length of a stored token hash (SHA-256 digest). Mirrored by the `*_token_hash_check` constraints. */
export const SECRET_TOKEN_HASH_BYTES = 32;

// 43 base64url characters; the last one carries only 4 meaningful bits for 32 bytes of input, so
// it must be one of the 16 characters whose low 2 bits are zero (canonical encoding only).
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** A stored token hash, as Prisma reads and writes `bytea` columns. */
export type SecretTokenHash = Uint8Array<ArrayBuffer>;

export interface IssuedSecretToken {
  /** Give this to the client once; never persist or log it. */
  readonly token: string;
  /** Persist this (`token_hash`). */
  readonly hash: SecretTokenHash;
}

/** Creates a new random token and the hash to store for it. */
export function issueSecretToken(): IssuedSecretToken {
  const token = randomBytes(SECRET_TOKEN_BYTES).toString('base64url');
  return { token, hash: digest(token) };
}

/** True when `value` has the exact shape of a token issued by {@link issueSecretToken}. */
export function isWellFormedSecretToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * Returns the hash to look a presented token up by, or `null` when the value cannot be a token
 * (wrong type, length or alphabet). Callers treat `null` exactly like "not found", so a malformed
 * token and an unknown one are indistinguishable to the client.
 */
export function hashSecretToken(value: unknown): SecretTokenHash | null {
  return isWellFormedSecretToken(value) ? digest(value) : null;
}

/** Constant-time equality for two token hashes (false when either is not a 32-byte hash). */
export function secretTokenHashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== SECRET_TOKEN_HASH_BYTES || b.byteLength !== SECRET_TOKEN_HASH_BYTES) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function digest(token: string): SecretTokenHash {
  // Copy into a plain ArrayBuffer-backed Uint8Array (what Prisma's Bytes type expects).
  return new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
}
