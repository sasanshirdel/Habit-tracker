import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LOGIN_THROTTLE_STORE, LoginThrottle, RedisLoginThrottleStore } from './login-throttle.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionService } from './session.service.js';

/**
 * Identity feature module (ADR-0017, ADR-0018): owns the identity tables and, since P2-02,
 * email/password registration, sign-in and sign-out. Uses the global `PrismaService`
 * (DatabaseModule) and the shared Redis connection (QueueModule). Tests replace
 * `LOGIN_THROTTLE_STORE` with a `MemoryLoginThrottleStore`.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    PasswordHasher,
    LoginThrottle,
    { provide: LOGIN_THROTTLE_STORE, useClass: RedisLoginThrottleStore },
  ],
  exports: [SessionService],
})
export class IdentityModule {}
