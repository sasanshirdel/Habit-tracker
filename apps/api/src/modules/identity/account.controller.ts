import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  SECURITY_EVENT_RETENTION_DAYS,
  type AccountSessionList,
  type RevokeOtherSessionsResponse,
  type SecurityEventList,
} from '@habit/shared-types';
import { CurrentUser, foundOr404, type RequestPrincipal } from '../../common/auth/index.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ApiDoc, ApiTag } from '../../openapi/index.js';
import {
  accountListQuerySchema,
  accountSessionListSchema,
  revokeOtherSessionsResponseSchema,
  securityEventListSchema,
  sessionIdParamSchema,
  sessionNotFoundErrorSchema,
  type AccountListQuery,
} from './account.schemas.js';
import { describeClient } from './client-description.js';
import { SecurityEventService } from './security-events.service.js';
import { clearSessionCookie } from './session-cookie.js';
import { SessionService } from './session.service.js';

/**
 * The signed-in user's sessions and security activity (backlog P2-08, ADR-0023) under
 * `/api/v1/account`. Every route is protected (no `@Public`), so the global `AuthGuard` requires
 * an active session and, for `DELETE`/`POST`, the CSRF token; rate-limit class `default`
 * (per user). Owner scoping: queries filter by the principal's user id, so another user's session
 * id answers 404 `NOT_FOUND` exactly like an unknown one.
 */
@ApiTag('Account', 'Your sessions (signed-in devices) and security activity.')
@Controller('account')
export class AccountController {
  constructor(
    private readonly sessions: SessionService,
    private readonly events: SecurityEventService,
  ) {}

  @ApiDoc({
    operationId: 'listSessions',
    summary: 'List your signed-in sessions',
    description:
      'Your active sessions — not signed out, not expired — newest sign-in first, with a coarse ' +
      'client description (browser, operating system and device class from the User-Agent at ' +
      'sign-in; no IP address or location is stored). `current` marks the session of this request.',
    responses: { 200: { description: 'A page of sessions.', schema: accountSessionListSchema } },
  })
  @Get('sessions')
  async listSessions(
    @CurrentUser() user: RequestPrincipal,
    @Query(new ZodValidationPipe(accountListQuerySchema)) query: AccountListQuery,
  ): Promise<AccountSessionList> {
    return this.sessions.listActive(user.userId, user.sessionId, query);
  }

  @ApiDoc({
    operationId: 'revokeSession',
    summary: 'Sign out one session',
    description:
      'Ends one of your active sessions; it stops working on its next request. Ending the ' +
      'session of this request signs you out here (the cookie is cleared). Records a ' +
      '`session_revoked` (or `sign_out`) security event. Another user’s, an unknown or an ' +
      'already ended session → 404 `NOT_FOUND`.',
    responses: {
      204: { description: 'The session has ended.' },
      404: {
        description: 'No such active session of yours (`NOT_FOUND`).',
        schema: sessionNotFoundErrorSchema,
      },
    },
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('sessions/:id')
  async revokeSession(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', new ZodValidationPipe(sessionIdParamSchema)) id: string,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<void> {
    const current = id === user.sessionId;
    const client = describeClient(req);
    const ended = await this.sessions.revokeOwned(
      user.userId,
      id,
      current ? 'sign_out' : 'revoked_by_user',
      { event: current ? 'sign_out' : 'session_revoked', client },
    );
    foundOr404(ended ? true : null);
    if (current) clearSessionCookie(res);
  }

  @ApiDoc({
    operationId: 'revokeOtherSessions',
    summary: 'Sign out all other sessions',
    description:
      'Ends every session of yours except the one of this request (which stays signed in) and ' +
      'records a `signed_out_other_sessions` security event.',
    responses: {
      200: { description: 'Other sessions ended.', schema: revokeOtherSessionsResponseSchema },
    },
  })
  @HttpCode(HttpStatus.OK)
  @Post('sessions/revoke-others')
  async revokeOtherSessions(
    @CurrentUser() user: RequestPrincipal,
    @Req() req: IncomingMessage,
  ): Promise<RevokeOtherSessionsResponse> {
    const revoked = await this.sessions.revokeOthers(user.userId, user.sessionId, {
      event: 'signed_out_other_sessions',
      client: describeClient(req),
    });
    return { revoked };
  }

  @ApiDoc({
    operationId: 'listSecurityEvents',
    summary: 'List your security activity',
    description:
      'Sign-ins, sign-outs, ended sessions, password resets and email verification of your ' +
      `account from the last ${SECURITY_EVENT_RETENTION_DAYS} days, newest first, each with the ` +
      'same coarse client description as sessions. Older events are deleted.',
    responses: { 200: { description: 'A page of events.', schema: securityEventListSchema } },
  })
  @Get('security-events')
  async listSecurityEvents(
    @CurrentUser() user: RequestPrincipal,
    @Query(new ZodValidationPipe(accountListQuerySchema)) query: AccountListQuery,
  ): Promise<SecurityEventList> {
    return this.events.list(user.userId, query);
  }
}
