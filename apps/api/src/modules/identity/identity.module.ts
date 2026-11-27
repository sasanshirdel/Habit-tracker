import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SESSION_RESOLVER } from '../../common/auth/index.js';
import { MailModule } from '../../mail/index.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { LOGIN_THROTTLE_STORE, LoginThrottle, RedisLoginThrottleStore } from './login-throttle.js';
import { PasswordHasher } from './password-hasher.js';
import { PasswordRecoveryService } from './password-recovery.service.js';
import {
  PasswordChangedEmailHandler,
  PasswordResetEmailHandler,
} from './password-reset-email.handler.js';
import { PasswordResetService } from './password-reset.service.js';
import { RequestSessionResolver } from './request-session.resolver.js';
import { SessionService } from './session.service.js';
import { VerificationEmailHandler } from './verification-email.handler.js';
import {
  RESEND_THROTTLE_STORE,
  RedisResendThrottleStore,
  VerificationResendThrottle,
} from './verification-resend-throttle.js';

/**
 * Identity feature module (ADR-0017, ADR-0018, ADR-0019): owns the identity tables,
 * email/password registration, sign-in and sign-out, and — since P2-03 — the global `AuthGuard`
 * (deny by default + CSRF) and the request session resolver.
 *
 * `@Global()` only so the platform rate limiter can inject {@link SESSION_RESOLVER} (a platform
 * token) without importing this module; nothing else is exported. Import it in `AppModule` after
 * `RateLimitModule` so the limiter's guard runs first. Tests replace `LOGIN_THROTTLE_STORE` with a
 * `MemoryLoginThrottleStore` and `RESEND_THROTTLE_STORE` with a `MemoryResendThrottleStore`.
 *
 * Email verification (P2-04, ADR-0021): the API side (confirm, resend, queueing the registration
 * email) lives here; the worker side (issuing tokens and sending the email) is
 * {@link IdentityJobsModule}, which the worker process imports. Password recovery (P2-05,
 * ADR-0022) is split the same way: request/reset routes here, reset-link and "password changed"
 * emails in the worker.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    PasswordHasher,
    LoginThrottle,
    RequestSessionResolver,
    { provide: SESSION_RESOLVER, useExisting: RequestSessionResolver },
    { provide: LOGIN_THROTTLE_STORE, useClass: RedisLoginThrottleStore },
    EmailVerificationService,
    VerificationResendThrottle,
    { provide: RESEND_THROTTLE_STORE, useClass: RedisResendThrottleStore },
    PasswordResetService,
    PasswordRecoveryService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, SESSION_RESOLVER],
})
export class IdentityModule {}

/**
 * Worker-side part of the identity module: the email job handlers with what they need (token
 * issuing, the mailer) — `identity.verification-email` (P2-04), `identity.password-reset-email`
 * and `identity.password-changed-email` (P2-05). Imported by `WorkerModule`, which registers the
 * handlers in `JOB_HANDLERS`. No controllers or guards.
 */
@Module({
  imports: [MailModule],
  providers: [
    EmailVerificationService,
    VerificationEmailHandler,
    PasswordResetService,
    PasswordResetEmailHandler,
    PasswordChangedEmailHandler,
  ],
  exports: [VerificationEmailHandler, PasswordResetEmailHandler, PasswordChangedEmailHandler],
})
export class IdentityJobsModule {}
