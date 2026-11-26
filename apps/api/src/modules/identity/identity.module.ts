import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SESSION_RESOLVER } from '../../common/auth/index.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { LOGIN_THROTTLE_STORE, LoginThrottle, RedisLoginThrottleStore } from './login-throttle.js';
import { PasswordHasher } from './password-hasher.js';
import { RequestSessionResolver } from './request-session.resolver.js';
import { SessionService } from './session.service.js';

/**
 * Identity feature module (ADR-0017, ADR-0018, ADR-0019): owns the identity tables,
 * email/password registration, sign-in and sign-out, and — since P2-03 — the global `AuthGuard`
 * (deny by default + CSRF) and the request session resolver.
 *
 * `@Global()` only so the platform rate limiter can inject {@link SESSION_RESOLVER} (a platform
 * token) without importing this module; nothing else is exported. Import it in `AppModule` after
 * `RateLimitModule` so the limiter's guard runs first. Tests replace `LOGIN_THROTTLE_STORE` with a
 * `MemoryLoginThrottleStore`.
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
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, SESSION_RESOLVER],
})
export class IdentityModule {}
