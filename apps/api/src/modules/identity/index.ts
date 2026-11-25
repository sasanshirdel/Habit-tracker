/**
 * Public surface of the identity feature module (ADR-0006: other code imports only this file).
 *
 * P2-01 delivers the identity tables (users, profiles, preferences, password credentials,
 * sessions, single-use tokens — owned by this module) and the secret-token primitives. The Nest
 * module, services and HTTP routes arrive with P2-02 (registration/login) and P2-03 (guards).
 */
export { IDENTITY_LIMITS, PASSWORD_HASH_PREFIX } from './identity.constants.js';
export {
  hashSecretToken,
  isWellFormedSecretToken,
  issueSecretToken,
  secretTokenHashesEqual,
  SECRET_TOKEN_BYTES,
  SECRET_TOKEN_HASH_BYTES,
  SECRET_TOKEN_LENGTH,
  type IssuedSecretToken,
  type SecretTokenHash,
} from './secret-token.js';
