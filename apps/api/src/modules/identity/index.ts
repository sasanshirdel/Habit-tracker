/**
 * Public surface of the identity feature module (ADR-0006: other code imports only this file).
 *
 * P2-01 delivers the identity tables (users, profiles, preferences, password credentials,
 * sessions, single-use tokens — owned by this module) and the secret-token primitives. P2-02 adds
 * the Nest module with email/password registration, sign-in and sign-out (ADR-0018); P2-03 adds
 * the authentication guard on top of `SessionService`.
 */
export {
  IDENTITY_LIMITS,
  PASSWORD_HASH_PREFIX,
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TIMEOUT_MS,
} from './identity.constants.js';
export { IdentityModule } from './identity.module.js';
export {
  LOGIN_LOCKOUT_POLICY,
  LOGIN_THROTTLE_STORE,
  MemoryLoginThrottleStore,
  type LoginThrottleStore,
} from './login-throttle.js';
export { ARGON2ID_PARAMS, PasswordHasher } from './password-hasher.js';
export { SessionService, type ActiveSession } from './session.service.js';
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
