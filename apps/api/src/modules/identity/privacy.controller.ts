import type { IncomingMessage, ServerResponse } from 'node:http';
import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  type AccountDeletionResponse,
  type AccountRestoreResponse,
  type UserDataExport,
} from '@habit/shared-types';
import { CurrentUser, Public, type RequestPrincipal } from '../../common/auth/index.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { UserDataExportService } from '../../data-export/index.js';
import { ApiDoc, ApiTag, rateLimitedErrorSchema } from '../../openapi/index.js';
import { RateLimit } from '../../rate-limit/index.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { AccountRestoreService } from './account-restore.service.js';
import { invalidTokenErrorSchema } from './auth.schemas.js';
import { describeClient } from './client-description.js';
import {
  accountDeletionBodySchema,
  accountDeletionResponseSchema,
  accountRestoreBodySchema,
  accountRestoreResponseSchema,
  reauthenticationFailedErrorSchema,
  userDataExportSchema,
  type AccountDeletionBody,
  type AccountRestoreBody,
} from './privacy.schemas.js';
import { SecurityEventService } from './security-events.service.js';
import { clearSessionCookie } from './session-cookie.js';

/** `habit-tracker-data-2026-11-27.json` — the date of the copy (UTC). */
export function exportFileName(exportedAt: string): string {
  return `habit-tracker-data-${exportedAt.slice(0, 10)}.json`;
}

/**
 * The signed-in user's data rights (backlog P2-10, ADR-0025) under `/api/v1/account`: a copy of
 * all their data, and deleting the account. Protected (deny-by-default guard; CSRF on both, as
 * they are POSTs), owner-only (no id in the URL), rate-limit class `sensitive` on top of
 * `default`. Neither route logs request or response bodies.
 */
@ApiTag('Privacy', 'A copy of your data, and deleting your account.')
@Controller('account')
export class PrivacyController {
  constructor(
    private readonly exports: UserDataExportService,
    private readonly deletion: AccountDeletionService,
    private readonly events: SecurityEventService,
  ) {}

  @ApiDoc({
    operationId: 'exportUserData',
    summary: 'Download a copy of your data',
    description:
      'Returns everything stored about you as one JSON document (a consistent snapshot of every ' +
      'module’s section) with `Content-Disposition: attachment`. Built on request — nothing is ' +
      'stored, cached or logged — and recorded as a `data_exported` security event. A POST (with ' +
      'the CSRF token) so that no link, prefetch or other site can trigger it. Rate-limit class ' +
      '`sensitive` (per user, fails closed).',
    responses: {
      200: { description: 'Your data.', schema: userDataExportSchema },
      429: { description: 'Too many exports (`RATE_LIMITED`).', schema: rateLimitedErrorSchema },
    },
  })
  @RateLimit('sensitive')
  @HttpCode(HttpStatus.OK)
  @Post('export')
  async exportData(
    @CurrentUser() user: RequestPrincipal,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<UserDataExport> {
    const document = await this.exports.exportFor(user.userId);
    await this.events.recordNow(user.userId, 'data_exported', describeClient(req));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exportFileName(document.exportedAt)}"`,
    );
    return document;
  }

  @ApiDoc({
    operationId: 'deleteAccount',
    summary: 'Delete your account',
    description:
      'Confirms with your current password, then deletes the account: every session ends (this ' +
      'response clears the cookie), sign-in stops working and emailed links stop working. The ' +
      `account and all its data stay restorable for ${ACCOUNT_DELETION_GRACE_DAYS} days with the ` +
      'link in the confirmation email; after that everything is erased for good and the address ' +
      'can be registered again. Records `account_deletion_requested`. Rate-limit class ' +
      '`sensitive` (per user, fails closed); wrong passwords also count towards the sign-in ' +
      'lockout of the address.',
    responses: {
      202: {
        description: 'Deleted; erased after the grace period.',
        schema: accountDeletionResponseSchema,
      },
      403: {
        description: 'Wrong password (`REAUTHENTICATION_FAILED`) or a missing/invalid CSRF token.',
        schema: reauthenticationFailedErrorSchema,
      },
      429: {
        description:
          'Too many attempts (`RATE_LIMITED`): the `sensitive` class or the sign-in lockout.',
        schema: rateLimitedErrorSchema,
      },
    },
  })
  @RateLimit('sensitive')
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('deletion')
  async deleteAccount(
    @CurrentUser() user: RequestPrincipal,
    @Body(new ZodValidationPipe(accountDeletionBodySchema)) body: AccountDeletionBody,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<AccountDeletionResponse> {
    const { purgeAfter } = await this.deletion.requestDeletion(
      user.userId,
      body.password,
      describeClient(req),
    );
    clearSessionCookie(res);
    return { status: 'deletion-scheduled', purgeAfter: purgeAfter.toISOString() };
  }
}

/**
 * Restoring a deleted account with the emailed link (P2-10, ADR-0025) under `/api/v1/auth`: public
 * (the account has no session any more), origin-checked like every unsafe request, rate-limit
 * class `auth`.
 */
@ApiTag('Auth', 'Registration, sign-in and sign-out with email and password.')
@Controller('auth')
export class AccountRestoreController {
  constructor(private readonly restore: AccountRestoreService) {}

  @ApiDoc({
    operationId: 'restoreAccount',
    summary: 'Restore a deleted account with the emailed link',
    description:
      'Consumes the token from the "account deleted" email and restores the account with all its ' +
      'data, if the grace period has not passed. Does not sign in; devices signed out at deletion ' +
      'stay signed out. Records `account_restored`. The web page posts it when the user presses ' +
      'the button. Rate-limit class `auth`.',
    responses: {
      200: { description: 'Restored.', schema: accountRestoreResponseSchema },
      400: {
        description: 'Invalid, expired, used or superseded link (`INVALID_TOKEN`).',
        schema: invalidTokenErrorSchema,
      },
    },
  })
  @Public()
  @RateLimit('auth')
  @HttpCode(HttpStatus.OK)
  @Post('account-restore')
  async restoreAccount(
    @Body(new ZodValidationPipe(accountRestoreBodySchema)) body: AccountRestoreBody,
    @Req() req: IncomingMessage,
  ): Promise<AccountRestoreResponse> {
    const result = await this.restore.restore(body.token, describeClient(req));
    if (result !== 'restored') {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'INVALID_TOKEN',
        'The link is invalid, expired or already used.',
      );
    }
    return { status: 'restored' };
  }
}
