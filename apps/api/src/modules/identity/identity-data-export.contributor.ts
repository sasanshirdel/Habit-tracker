import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UserDataExportRegistry, type UserDataContributor } from '../../data-export/index.js';
import type { DatabaseTransaction } from '../../database/index.js';
import { clientFromColumns } from './client-description.js';

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

/**
 * The identity module's section (`account`) of the user's data export (backlog P2-10, ADR-0025):
 * the account, profile, preferences, sessions, security events and emailed-link metadata — every
 * stored row of the user, newest first. Secrets are never exported: the password hash (only
 * whether a password is set and when it changed), session token hashes and link token hashes.
 */
@Injectable()
export class IdentityDataExportContributor implements UserDataContributor, OnModuleInit {
  readonly section = 'account';
  readonly tables = {
    users: 'included',
    user_profiles: 'included',
    user_preferences: 'included',
    user_sessions: 'included',
    user_security_events: 'included',
    user_tokens: 'included',
    user_password_credentials: {
      excluded:
        'Holds only the Argon2id hash of the password (a secret, not user content); the export says whether a password is set and when it was last changed.',
    },
  } as const;

  constructor(private readonly registry: UserDataExportRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async collect(db: DatabaseTransaction, userId: string): Promise<unknown> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        createdAt: true,
        updatedAt: true,
        passwordCredential: { select: { updatedAt: true } },
        profile: { select: { displayName: true, createdAt: true, updatedAt: true } },
        preference: {
          select: {
            locale: true,
            timezone: true,
            theme: true,
            calendar: true,
            weekStart: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!user) return null;
    // Sequential: one transaction is one connection.
    const sessions = await db.userSession.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        revokedReason: true,
        clientBrowser: true,
        clientOs: true,
        clientDevice: true,
      },
    });
    const events = await db.userSecurityEvent.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        type: true,
        createdAt: true,
        clientBrowser: true,
        clientOs: true,
        clientDevice: true,
      },
    });
    const links = await db.userToken.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      select: { purpose: true, email: true, createdAt: true, expiresAt: true, consumedAt: true },
    });
    return {
      user: {
        id: user.id,
        email: user.email,
        emailVerifiedAt: iso(user.emailVerifiedAt),
        createdAt: iso(user.createdAt),
        updatedAt: iso(user.updatedAt),
      },
      password: {
        set: user.passwordCredential !== null,
        changedAt: iso(user.passwordCredential?.updatedAt),
      },
      profile: user.profile
        ? {
            displayName: user.profile.displayName,
            createdAt: iso(user.profile.createdAt),
            updatedAt: iso(user.profile.updatedAt),
          }
        : null,
      preferences: user.preference
        ? {
            locale: user.preference.locale,
            timezone: user.preference.timezone,
            theme: user.preference.theme,
            calendar: user.preference.calendar,
            weekStart: user.preference.weekStart,
            createdAt: iso(user.preference.createdAt),
            updatedAt: iso(user.preference.updatedAt),
          }
        : null,
      sessions: sessions.map((s) => ({
        id: s.id,
        signedInAt: iso(s.createdAt),
        lastActiveAt: iso(s.lastUsedAt),
        expiresAt: iso(s.expiresAt),
        endedAt: iso(s.revokedAt),
        endReason: s.revokedReason,
        client: clientFromColumns(s),
      })),
      securityEvents: events.map((e) => ({
        id: e.id,
        type: e.type,
        occurredAt: iso(e.createdAt),
        client: clientFromColumns(e),
      })),
      emailLinks: links.map((l) => ({
        purpose: l.purpose,
        sentTo: l.email,
        createdAt: iso(l.createdAt),
        expiresAt: iso(l.expiresAt),
        usedAt: iso(l.consumedAt),
      })),
    };
  }
}
