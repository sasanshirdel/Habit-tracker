import type { IncomingMessage, ServerResponse } from 'node:http';
import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { LoginResponse, RegistrationAcceptedResponse } from '@habit/shared-types';
import { ApiException } from '../../common/errors/api-exception.js';
import { setRequestUserId } from '../../common/request/request-context.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ApiDoc, ApiTag, rateLimitedErrorSchema } from '../../openapi/index.js';
import { RateLimit } from '../../rate-limit/index.js';
import {
  invalidCredentialsErrorSchema,
  loginBodySchema,
  loginResponseSchema,
  registerBodySchema,
  registrationAcceptedResponseSchema,
  unauthenticatedErrorSchema,
  type LoginInput,
  type RegisterInput,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { LoginLockedError } from './login-throttle.js';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-cookie.js';

const COOKIE_NOTE =
  'The session travels only in the `__Host-session` cookie (`HttpOnly; Secure; SameSite=Lax; ' +
  'Path=/`); call with credentials included.';

/**
 * Email/password authentication (backlog P2-02, ADR-0018) under `/api/v1/auth`.
 *
 * Out of scope here, by design: CSRF tokens/Origin checks and the deny-by-default guard with
 * `@CurrentUser()` (P2-03), email verification (P2-04), password recovery (P2-05), the session
 * list and security events (P2-08), the pages (P2-09).
 */
@ApiTag('Auth', 'Registration, sign-in and sign-out with email and password.')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @ApiDoc({
    operationId: 'register',
    summary: 'Register with email and password',
    description:
      'Creates an account with an Argon2id password hash, the language preference and time zone. ' +
      'Answers 202 with the same body whether or not the address is already registered (no ' +
      'account enumeration); an existing account is left unchanged. Does not sign in. ' +
      'Rate-limit class `auth` (per client address, fails closed).',
    responses: {
      202: { description: 'Accepted.', schema: registrationAcceptedResponseSchema },
    },
  })
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
        description: 'Signed in; `Set-Cookie: __Host-session=…`.',
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
      result = await this.auth.login(body, readSessionCookie(req));
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
    return { user: result.user };
  }

  @ApiDoc({
    operationId: 'logout',
    summary: 'Sign out',
    description:
      'Revokes the session in the cookie, if any, and clears the cookie. Always 204 (idempotent).',
    responses: { 204: { description: 'Signed out; the cookie is cleared.' } },
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<void> {
    await this.auth.logout(readSessionCookie(req));
    clearSessionCookie(res);
  }

  @ApiDoc({
    operationId: 'logoutEverywhere',
    summary: 'Sign out everywhere',
    description:
      'Revokes every session of the signed-in user (all devices), including this one, and clears ' +
      'the cookie. Needs an active session.',
    responses: {
      204: { description: 'All sessions ended; the cookie is cleared.' },
      401: {
        description: 'No active session (`UNAUTHENTICATED`).',
        schema: unauthenticatedErrorSchema,
      },
    },
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout-everywhere')
  async logoutEverywhere(
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<void> {
    const ended = await this.auth.logoutEverywhere(readSessionCookie(req));
    clearSessionCookie(res);
    if (!ended) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Not signed in.');
    }
    setRequestUserId(ended.userId);
  }
}
