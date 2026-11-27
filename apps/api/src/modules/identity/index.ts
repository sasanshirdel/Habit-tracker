/**
 * Public surface of the identity feature module (ADR-0006: other code imports only this file).
 *
 * P2-01 delivers the identity tables (users, profiles, preferences, password credentials,
 * sessions, single-use tokens — owned by this module) and the secret-token primitives. P2-02 adds
 * the Nest module with email/password registration, sign-in and sign-out (ADR-0018); P2-03 adds
 * the global deny-by-default `AuthGuard` with CSRF checks on top of `SessionService` (ADR-0019).
 * P2-04 adds email verification and the worker-side `IdentityJobsModule` (ADR-0021).
 * Route markers (`@Public()`, `@CurrentUser()`) are platform code in `common/auth`.
 */
export {
  IDENTITY_LIMITS,
  PASSWORD_HASH_PREFIX,
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TIMEOUT_MS,
} from './identity.constants.js';
export { AuthGuard } from './auth.guard.js';
export { CSRF_HEADER, CSRF_TOKEN_LENGTH, csrfTokenFor, csrfTokenMatches } from './csrf-token.js';
export { IdentityJobsModule, IdentityModule } from './identity.module.js';
export {
  EMAIL_VERIFICATION_POLICY,
  VERIFICATION_EMAIL_JOB,
  VERIFICATION_EMAIL_POLICY_NAME,
  registrationEmailJobId,
} from './email-verification.policy.js';
export { EmailVerificationService, type ConfirmResult } from './email-verification.service.js';
export {
  ALREADY_REGISTERED_COPY,
  IDENTITY_EMAIL_TEMPLATES,
  VERIFY_EMAIL_COPY,
  alreadyRegisteredMessage,
  signInLink,
  verificationLink,
  verifyEmailMessage,
} from './identity-emails.js';
export {
  VerificationEmailHandler,
  type VerificationEmailOutcome,
} from './verification-email.handler.js';
export {
  MemoryResendThrottleStore,
  RESEND_THROTTLE_STORE,
  type ResendThrottleStore,
} from './verification-resend-throttle.js';
export {
  LOGIN_LOCKOUT_POLICY,
  LOGIN_THROTTLE_STORE,
  MemoryLoginThrottleStore,
  type LoginThrottleStore,
} from './login-throttle.js';
export { ARGON2ID_PARAMS, PasswordHasher } from './password-hasher.js';
export { RequestSessionResolver } from './request-session.resolver.js';
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
