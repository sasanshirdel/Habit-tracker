import { Body, Controller, Get, Patch } from '@nestjs/common';
import type { UserPreferences, UserProfile } from '@habit/shared-types';
import { CurrentUser, type RequestPrincipal } from '../../common/auth/index.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ApiDoc, ApiTag } from '../../openapi/index.js';
import {
  updatePreferencesBodySchema,
  updateProfileBodySchema,
  userPreferencesSchema,
  userProfileSchema,
  type UpdatePreferencesInput,
  type UpdateProfileInput,
} from './profile.schemas.js';
import { ProfileService } from './profile.service.js';

const PROTECTED_NOTE =
  'Signed in only; `PATCH` also needs the CSRF token (ADR-0019). Rate-limit class `default` ' +
  '(per user). Always the caller’s own data: there is no id to name another account.';

/**
 * The signed-in user's profile and preferences (backlog P2-07, ADR-0024) under
 * `/api/v1/account`. No `@Public`, so the global `AuthGuard` requires an active session and, for
 * `PATCH`, the CSRF token. Avatar upload is a follow-up (object storage, ROADMAP #3).
 */
@ApiTag('Profile', 'Your display name and preferences (language, time zone, theme, calendar).')
@Controller('account')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @ApiDoc({
    operationId: 'getProfile',
    summary: 'Get your profile',
    description: PROTECTED_NOTE,
    responses: { 200: { description: 'Your profile.', schema: userProfileSchema } },
  })
  @Get('profile')
  getProfile(@CurrentUser() user: RequestPrincipal): Promise<UserProfile> {
    return this.profiles.getProfile(user.userId);
  }

  @ApiDoc({
    operationId: 'updateProfile',
    summary: 'Update your profile',
    description: `Sets or removes your display name and returns the stored profile. ${PROTECTED_NOTE}`,
    responses: { 200: { description: 'The updated profile.', schema: userProfileSchema } },
  })
  @Patch('profile')
  updateProfile(
    @CurrentUser() user: RequestPrincipal,
    @Body(new ZodValidationPipe(updateProfileBodySchema)) body: UpdateProfileInput,
  ): Promise<UserProfile> {
    return this.profiles.updateProfile(user.userId, body);
  }

  @ApiDoc({
    operationId: 'getPreferences',
    summary: 'Get your preferences',
    description: PROTECTED_NOTE,
    responses: { 200: { description: 'Your preferences.', schema: userPreferencesSchema } },
  })
  @Get('preferences')
  getPreferences(@CurrentUser() user: RequestPrincipal): Promise<UserPreferences> {
    return this.profiles.getPreferences(user.userId);
  }

  @ApiDoc({
    operationId: 'updatePreferences',
    summary: 'Update your preferences',
    description:
      'Changes any subset of your preferences and returns all of them. The time zone must be an ' +
      `IANA name the server’s ICU data knows (offsets and abbreviations are rejected). ${PROTECTED_NOTE}`,
    responses: { 200: { description: 'All your preferences.', schema: userPreferencesSchema } },
  })
  @Patch('preferences')
  updatePreferences(
    @CurrentUser() user: RequestPrincipal,
    @Body(new ZodValidationPipe(updatePreferencesBodySchema)) body: UpdatePreferencesInput,
  ): Promise<UserPreferences> {
    return this.profiles.updatePreferences(user.userId, body);
  }
}
