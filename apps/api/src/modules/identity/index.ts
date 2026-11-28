/**
 * Public surface of the identity feature module (ADR-0006: other code imports only this file).
 *
 * P2-01 delivers the identity tables (users, profiles, preferences, password credentials,
 * sessions, single-use tokens — owned by this module) and the secret-token primitives. P2-02 adds
 * the Nest module with email/password registration, sign-in and sign-out (ADR-0018); P2-03 adds
 * the global deny-by-default `AuthGuard` with CSRF checks on top of `SessionService` (ADR-0019).
 * P2-04 adds email verification and the worker-side `IdentityJobsModule` (ADR-0021); P2-05 adds
 * password recovery (ADR-0022); P2-08 adds session management and security events (ADR-0023);
 * P2-07 adds profile and preferences (ADR-0024); P2-10 adds data export, account deletion with a
 * restore window and the purge (ADR-0025).
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
export {
  ACCOUNT_DELETED_EMAIL_JOB,
  ACCOUNT_DELETION_POLICY,
  ACCOUNT_PURGE_JOB,
  purgeAfter,
} from './account-deletion.policy.js';
export {
  AccountDeletedEmailHandler,
  AccountPurgeHandler,
  type AccountDeletedEmailOutcome,
} from './account-deletion.handlers.js';
export { AccountDeletionService, ReauthenticationFailedError } from './account-deletion.service.js';
export { AccountPurgeService } from './account-purge.service.js';
export { AccountRestoreService, type AccountRestoreResult } from './account-restore.service.js';
export { IdentityDataExportContributor } from './identity-data-export.contributor.js';
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
  PASSWORD_CHANGED_EMAIL_JOB,
  PASSWORD_RESET_EMAIL_JOB,
  PASSWORD_RESET_POLICY,
  PASSWORD_RESET_REQUEST_LIMITS,
  PASSWORD_RESET_REQUEST_POLICY_NAME,
} from './password-reset.policy.js';
export { PasswordResetService, type PasswordResetResult } from './password-reset.service.js';
export {
  PasswordRecoveryService,
  type ResetPasswordOutcome,
  type ResetRequestOutcome,
} from './password-recovery.service.js';
export {
  PasswordChangedEmailHandler,
  PasswordResetEmailHandler,
  type PasswordEmailOutcome,
} from './password-reset-email.handler.js';
export {
  ACCOUNT_DELETED_COPY,
  ALREADY_REGISTERED_COPY,
  accountDeletedMessage,
  accountRestoreLink,
  formatPurgeDate,
  IDENTITY_EMAIL_TEMPLATES,
  PASSWORD_CHANGED_COPY,
  PASSWORD_RESET_COPY,
  passwordChangedMessage,
  passwordResetLink,
  passwordResetMessage,
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
  VERIFICATION_RESEND_LIMITS,
  type EmailSendLimits,
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
export {
  ENDED_SESSION_RETENTION_MS,
  SessionService,
  type ActiveSession,
} from './session.service.js';
export { ProfileService } from './profile.service.js';
export { SECURITY_EVENT_RETENTION_MS, SecurityEventService } from './security-events.service.js';
export { UNKNOWN_CLIENT, describeClient, describeUserAgent } from './client-description.js';
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
