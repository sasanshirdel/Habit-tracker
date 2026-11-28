import type { IncomingMessage, ServerResponse } from 'node:http';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type {
  EmailVerifiedResponse,
  LoginResponse,
  PasswordResetAcceptedResponse,
  PasswordResetResponse,
  RegistrationAcceptedResponse,
  SessionResponse,
  VerificationEmailAcceptedResponse,
} from '@habit/shared-types';
import { CurrentUser, Public, type RequestPrincipal } from '../../common/auth/index.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { setRequestUserId } from '../../common/request/request-context.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ApiDoc, ApiTag, rateLimitedErrorSchema } from '../../openapi/index.js';
import { RateLimit } from '../../rate-limit/index.js';
import {
  confirmEmailBodySchema,
  emailVerifiedResponseSchema,
  invalidCredentialsErrorSchema,
  invalidTokenErrorSchema,
  verificationEmailAcceptedResponseSchema,
  type ConfirmEmailInput,
  loginBodySchema,
  loginResponseSchema,
  passwordResetAcceptedResponseSchema,
  passwordResetConfirmBodySchema,
  passwordResetRequestBodySchema,
  passwordResetResponseSchema,
  type PasswordResetConfirmBody,
  type PasswordResetRequestBody,
  registerBodySchema,
  registrationAcceptedResponseSchema,
  sessionResponseSchema,
  type LoginInput,
  type RegisterInput,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { describeClient } from './client-description.js';
import { csrfTokenFor } from './csrf-token.js';
import { LoginLockedError } from './login-throttle.js';
import { PasswordRecoveryService } from './password-recovery.service.js';
import { ResendThrottledError } from './verification-resend-throttle.js';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-cookie.js';

const COOKIE_NOTE =
  'The session travels only in the `__Host-session` cookie (`HttpOnly; Secure; SameSite=Lax; ' +
  'Path=/`); call with credentials included.';

/**
 * Email/password authentication (backlog P2-02, ADR-0018) under `/api/v1/auth`.
 *
 * Since P2-03 (ADR-0019) every route here passes the global `AuthGuard`: register and login are
 * `@Public()` (origin check only), logout is public with an optional session (origin check, plus
 * the CSRF token when a live session is presented), logout-everywhere and the session read are
 * protected. Email verification (P2-04, ADR-0021): confirm is public (origin check, `auth` class),
 * resend is protected. Password recovery (P2-05, ADR-0022): request and confirm are public
 * (origin check, `auth` class). Sign-in, sign-out, verification and reset write security events
 * (P2-08, ADR-0023); the session list and revocation are `AccountController`.
 */
@ApiTag('Auth', 'Registration, sign-in and sign-out with email and password.')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly recovery: PasswordRecoveryService,
  ) {}

  @ApiDoc({
    operationId: 'register',
    summary: 'Register with email and password',
    description:
      'Creates an account with an Argon2id password hash, the language preference and time zone, ' +
      'and queues an email to the address: a verification link for a new (or still unverified) ' +
      'account, a "you already have an account" notice for a verified one — at most one per ' +
      'account per 15 minutes. Answers 202 with the same body whether or not the address is ' +
      'already registered (no account enumeration); an existing account is left unchanged. Does ' +
      'not sign in; unverified accounts can sign in. ' +
      'Rate-limit class `auth` (per client address, fails closed).',
    responses: {
      202: { description: 'Accepted.', schema: registrationAcceptedResponseSchema },
    },
  })
  @Public()
  @RateLimit('auth')
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerBodySchema)) body: RegisterInput,
  ): Promise<RegistrationAcceptedResponse> {
    await this.auth.register(body);
    return { status: 'accepted' };
  }

  @ApiDoc({
    operationId: 'login',
    summary: 'Sign in with email and password',
    description:
      `Opens a new session and sets it as a cookie. ${COOKIE_NOTE} A session cookie sent with ` +
      'the request is revoked (rotation on sign-in). Wrong address and wrong password get the ' +
      'same 401. Rate limits: class `auth` per client address, plus a progressive lockout per ' +
      'submitted address (5 consecutive failures → 1 min, doubling to 15 min; `policy: ' +
      '"login-account"`).',
    responses: {
      200: {
        description:
          'Signed in; `Set-Cookie: __Host-session=…`. The body carries the new session’s CSRF ' +
          'token.',
        schema: loginResponseSchema,
      },
      401: {
        description: 'Unknown address or wrong password (`INVALID_CREDENTIALS`).',
        schema: invalidCredentialsErrorSchema,
      },
      429: {
        description:
          'Too many attempts (`RATE_LIMITED`): the per-address `auth` limit, or the submitted ' +
          'email address is temporarily locked (`details.policy` `login-account`).',
        schema: rateLimitedErrorSchema,
      },
    },
  })
  @Public()
  @RateLimit('auth')
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginBodySchema)) body: LoginInput,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<LoginResponse> {
    let result;
    try {
      result = await this.auth.login(body, readSessionCookie(req), describeClient(req));
    } catch (error) {
      if (error instanceof LoginLockedError) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }
    if (result.kind !== 'signed-in') {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_CREDENTIALS',
        'Invalid email or password.',
      );
    }
    setRequestUserId(result.user.id);
    setSessionCookie(res, result.token);
    return { user: result.user, csrfToken: csrfTokenFor(result.token) };
  }

  @ApiDoc({
    operationId: 'logout',
    summary: 'Sign out',
    description:
      'Revokes the session in the cookie, if any, and clears the cookie. 204 also without a ' +
      'session (idempotent). When the cookie opens a live session, `X-CSRF-Token` is required.',
    responses: { 204: { description: 'Signed out; the cookie is cleared.' } },
  })
  @Public({ session: 'optional' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<void> {
    await this.auth.logout(readSessionCookie(req), describeClient(req));
    clearSessionCookie(res);
  }

  @ApiDoc({
    operationId: 'logoutEverywhere',
    summary: 'Sign out everywhere',
    description:
      'Revokes every session of the signed-in user (all devices), including this one, and clears ' +
      'the cookie.',
    responses: { 204: { description: 'All sessions ended; the cookie is cleared.' } },
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout-everywhere')
  async logoutEverywhere(
    @CurrentUser() user: RequestPrincipal,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<void> {
    await this.auth.logoutEverywhere(user.userId, describeClient(req));
    clearSessionCookie(res);
  }

  @ApiDoc({
    operationId: 'getSession',
    summary: 'Current session',
    description:
      'The signed-in account and the CSRF token of the presented session. The web app calls it ' +
      'after a reload (the cookie is `HttpOnly`); 401 means signed out. Refreshes the idle timer.',
    responses: { 200: { description: 'Signed in.', schema: sessionResponseSchema } },
  })
  @Get('session')
  async session(
    @CurrentUser() user: RequestPrincipal,
    @Req() req: IncomingMessage,
  ): Promise<SessionResponse> {
    const account = await this.auth.currentUser(user.userId);
    const token = readSessionCookie(req);
    if (!account || token === undefined) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Not signed in.');
    }
    return { user: account, csrfToken: csrfTokenFor(token) };
  }
  @ApiDoc({
    operationId: 'confirmEmail',
    summary: 'Verify an email address',
    description:
      'Consumes the token from the emailed link and marks the address verified. A token works ' +
      'once, for 24 hours, for the address it was sent to, and only while it is the newest link ' +
      'of that account. Every failure is the same 400 `INVALID_TOKEN`. Does not sign in and ' +
      'needs no session; the web page posts it after the user presses a button (opening a link ' +
      'never verifies). Rate-limit class `auth`.',
    responses: {
      200: { description: 'Verified.', schema: emailVerifiedResponseSchema },
      400: {
        description:
          'Invalid, expired, used or superseded link (`INVALID_TOKEN`), or a malformed body ' +
          '(`VALIDATION_FAILED`).',
        schema: invalidTokenErrorSchema,
      },
    },
  })
  @Public()
  @RateLimit('auth')
  @HttpCode(HttpStatus.OK)
  @Post('verification/confirm')
  async confirmEmail(
    @Body(new ZodValidationPipe(confirmEmailBodySchema)) body: ConfirmEmailInput,
    @Req() req: IncomingMessage,
  ): Promise<EmailVerifiedResponse> {
    const result = await this.auth.confirmEmail(body.token, describeClient(req));
    if (result !== 'verified') {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'INVALID_TOKEN',
        'The link is invalid, expired or already used.',
      );
    }
    return { status: 'verified' };
  }

  @ApiDoc({
    operationId: 'resendVerificationEmail',
    summary: 'Email a new verification link',
    description:
      'Queues a new verification link to the signed-in account’s address; earlier links stop ' +
      'working. 202 also when the address is already verified (nothing is sent). Per account at ' +
      'most once a minute and 5 times an hour (429 `RATE_LIMITED`, `policy: ' +
      '"verification-email"`), plus rate-limit class `auth`.',
    responses: {
      202: { description: 'Accepted.', schema: verificationEmailAcceptedResponseSchema },
      429: {
        description:
          'Too many requests (`RATE_LIMITED`): the per-address `auth` limit, or this account ' +
          'asked too soon or too often (`details.policy` `verification-email`).',
        schema: rateLimitedErrorSchema,
      },
    },
  })
  @RateLimit('auth')
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('verification/resend')
  async resendVerificationEmail(
    @CurrentUser() user: RequestPrincipal,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<VerificationEmailAcceptedResponse> {
    try {
      await this.auth.requestVerificationEmail(user.userId, user.emailVerified);
    } catch (error) {
      if (error instanceof ResendThrottledError) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }
    return { status: 'accepted' };
  }

  @ApiDoc({
    operationId: 'requestPasswordReset',
    summary: 'Email a password-reset link',
    description:
      'Answers 202 at once with the same body for every well-formed address; the rest happens ' +
      'after the response, so neither the answer nor its timing says whether an account exists. ' +
      'If the address belongs to an account that is not deleted, a reset link is emailed in the ' +
      'account language — at most once a minute and 5 times an hour per address (more requests ' +
      'are accepted and silently dropped). A link works once, for 30 minutes, and only the newest ' +
      'one works. Rate-limit class `auth` (per client address, fails closed).',
    responses: {
      202: { description: 'Accepted.', schema: passwordResetAcceptedResponseSchema },
    },
  })
  @Public()
  @RateLimit('auth')
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('password-reset/request')
  requestPasswordReset(
    @Body(new ZodValidationPipe(passwordResetRequestBodySchema)) body: PasswordResetRequestBody,
  ): PasswordResetAcceptedResponse {
    // Deliberately not awaited: see PasswordRecoveryService (no enumeration by timing).
    void this.recovery.requestReset(body.email);
    return { status: 'accepted' };
  }

  @ApiDoc({
    operationId: 'resetPassword',
    summary: 'Set a new password with a reset link',
    description:
      'Consumes the token from the emailed link and sets the new password (Argon2id). Every ' +
      'session of the account ends (`password_changed`), other reset links stop working, the ' +
      'address counts as verified, the sign-in lockout of the address is cleared and a "your ' +
      'password was changed" email is sent. Does not sign in. Needs no session; the web page ' +
      'posts it when the user presses the button. Rate-limit class `auth`.',
    responses: {
      200: { description: 'Password changed.', schema: passwordResetResponseSchema },
      400: {
        description:
          'Invalid, expired, used or superseded link (`INVALID_TOKEN`), or a body that breaks the ' +
          'rules — e.g. a too-short password (`VALIDATION_FAILED`; the link stays usable).',
        schema: invalidTokenErrorSchema,
      },
    },
  })
  @Public()
  @RateLimit('auth')
  @HttpCode(HttpStatus.OK)
  @Post('password-reset/confirm')
  async resetPassword(
    @Body(new ZodValidationPipe(passwordResetConfirmBodySchema)) body: PasswordResetConfirmBody,
    @Req() req: IncomingMessage,
  ): Promise<PasswordResetResponse> {
    const result = await this.recovery.resetPassword(
      body.token,
      body.password,
      describeClient(req),
    );
    if (result !== 'reset') {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'INVALID_TOKEN',
        'The link is invalid, expired or already used.',
      );
    }
    return { status: 'password-reset' };
  }
}
