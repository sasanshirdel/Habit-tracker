import { Injectable } from '@nestjs/common';
import type { UserPreferences, UserProfile } from '@habit/shared-types';
import { foundOr404 } from '../../common/auth/index.js';
import { PrismaService } from '../../database/index.js';
import type { UpdatePreferencesInput, UpdateProfileInput } from './profile.schemas.js';

const preferenceColumns = {
  locale: true,
  timezone: true,
  theme: true,
  calendar: true,
  weekStart: true,
} as const;

/**
 * The signed-in user's profile and preferences (backlog P2-07, ADR-0024). Every query is keyed by
 * the principal's user id — there is no route parameter that could name another account.
 *
 * None of these fields is security-relevant (ADR-0024): no security event is recorded, and the
 * values are never logged (`displayName` is a redacted log key).
 */
@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string): Promise<UserProfile> {
    const row = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { displayName: true },
    });
    // Every account gets a profile row at registration; a missing one simply has no name yet.
    return { displayName: row?.displayName ?? null };
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<UserProfile> {
    const row = await this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId, displayName: input.displayName },
      update: { displayName: input.displayName },
      select: { displayName: true },
    });
    return { displayName: row.displayName };
  }

  async getPreferences(userId: string): Promise<UserPreferences> {
    return foundOr404(
      await this.prisma.userPreference.findUnique({
        where: { userId },
        select: preferenceColumns,
      }),
    );
  }

  async updatePreferences(userId: string, input: UpdatePreferencesInput): Promise<UserPreferences> {
    // updateMany: a missing row answers 404 instead of a Prisma "record not found" error.
    const { count } = await this.prisma.userPreference.updateMany({
      where: { userId },
      data: input,
    });
    foundOr404(count === 1 ? true : null);
    return this.getPreferences(userId);
  }
}
