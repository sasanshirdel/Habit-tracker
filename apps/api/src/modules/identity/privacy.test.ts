import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  SECURITY_EVENT_TYPES,
  USER_DATA_EXPORT_FORMAT,
  USER_DATA_EXPORT_VERSION,
  type AccountDeletionRequest,
  type AccountDeletionResponse,
  type AccountRestoreRequest,
  type AccountRestoreResponse,
  type UserDataExport,
} from '@habit/shared-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { UserDataExportRegistry, type UserDataContributor } from '../../data-export/index.js';
import { SecurityEventType, UserTokenPurpose } from '../../generated/prisma/enums.js';
import {
  ACCOUNT_DELETED_EMAIL_JOB,
  ACCOUNT_DELETION_POLICY,
  ACCOUNT_PURGE_JOB,
  purgeAfter,
} from './account-deletion.policy.js';
import { ReauthenticationFailedError } from './account-deletion.service.js';
import {
  ACCOUNT_DELETED_COPY,
  accountDeletedMessage,
  accountRestoreLink,
  formatPurgeDate,
} from './identity-emails.js';
import { IdentityDataExportContributor } from './identity-data-export.contributor.js';
import { exportFileName } from './privacy.controller.js';
import {
  accountDeletionBodySchema,
  accountDeletionResponseSchema,
  accountRestoreBodySchema,
  accountRestoreResponseSchema,
  userDataExportSchema,
} from './privacy.schemas.js';
import { issueSecretToken } from './secret-token.js';

// Backlog P2-10 (ADR-0025): data export, account deletion, restore and purge — the parts that need
// no database. The flows themselves run on real PostgreSQL/Redis + worker in privacy.int.test.ts.

const migrationsDir = resolve(import.meta.dirname, '../../../prisma/migrations');
const migration = readdirSync(migrationsDir).find((d) => d.endsWith('_account_deletion'));
const sql = readFileSync(resolve(migrationsDir, migration ?? 'missing', 'migration.sql'), 'utf8');

describe('privacy contracts', () => {
  it('schemas mirror @habit/shared-types', () => {
    expectTypeOf<z.output<typeof userDataExportSchema>>().toEqualTypeOf<UserDataExport>();
    expectTypeOf<
      z.input<typeof accountDeletionBodySchema>
    >().toEqualTypeOf<AccountDeletionRequest>();
    expectTypeOf<
      z.output<typeof accountDeletionResponseSchema>
    >().toEqualTypeOf<AccountDeletionResponse>();
    expectTypeOf<z.input<typeof accountRestoreBodySchema>>().toEqualTypeOf<AccountRestoreRequest>();
    expectTypeOf<
      z.output<typeof accountRestoreResponseSchema>
    >().toEqualTypeOf<AccountRestoreResponse>();
  });

  it('deletion and restore bodies are strict', () => {
    expect(accountDeletionBodySchema.safeParse({ password: 'x', userId: 'y' }).success).toBe(false);
    expect(accountDeletionBodySchema.safeParse({ password: '' }).success).toBe(false);
    expect(accountRestoreBodySchema.safeParse({ token: 'a', extra: 1 }).success).toBe(false);
    expect(accountRestoreBodySchema.safeParse({ token: 'a'.repeat(129) }).success).toBe(false);
  });

  it('the export document has a fixed format marker', () => {
    const doc: UserDataExport = {
      format: USER_DATA_EXPORT_FORMAT,
      version: USER_DATA_EXPORT_VERSION,
      exportedAt: '2026-11-27T10:00:00.000Z',
      sections: { account: {} },
    };
    expect(userDataExportSchema.parse(doc)).toEqual(doc);
    expect(userDataExportSchema.safeParse({ ...doc, format: 'other' }).success).toBe(false);
    expect(exportFileName(doc.exportedAt)).toBe('habit-tracker-data-2026-11-27.json');
  });

  it('wrong password is 403 REAUTHENTICATION_FAILED (the session itself stays valid)', () => {
    const error = new ReauthenticationFailedError();
    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe('REAUTHENTICATION_FAILED');
  });
});

describe('account deletion policy', () => {
  it('grace period comes from the shared constant (interim 30 days)', () => {
    expect(ACCOUNT_DELETION_GRACE_DAYS).toBe(30);
    expect(ACCOUNT_DELETION_POLICY.graceMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(purgeAfter(new Date('2026-11-27T10:00:00Z')).toISOString()).toBe(
      '2026-12-27T10:00:00.000Z',
    );
  });

  it('jobs carry the account id only (or nothing)', () => {
    expect(ACCOUNT_DELETED_EMAIL_JOB).toMatchObject({
      name: 'identity.account-deleted-email',
      queue: 'email',
    });
    const id = '0190d7a0-0000-7000-8000-0000000000aa';
    expect(ACCOUNT_DELETED_EMAIL_JOB.schema.parse({ userId: id })).toEqual({ userId: id });
    expect(ACCOUNT_DELETED_EMAIL_JOB.schema.safeParse({ userId: id, email: 'a@b.c' }).success).toBe(
      false,
    );
    expect(ACCOUNT_PURGE_JOB).toMatchObject({ name: 'identity.account-purge', queue: 'system' });
    expect(ACCOUNT_PURGE_JOB.schema.safeParse({ userId: id }).success).toBe(false);
  });
});

describe('account deletion migration', () => {
  it('adds the event types, the token purpose and the purge index', () => {
    expect(Object.values(SecurityEventType)).toEqual([...SECURITY_EVENT_TYPES]);
    expect(Object.values(UserTokenPurpose)).toContain('account_restore');
    for (const type of ['data_exported', 'account_deletion_requested', 'account_restored']) {
      expect(sql).toContain(`ALTER TYPE "security_event_type" ADD VALUE '${type}';`);
    }
    expect(sql).toContain(`ALTER TYPE "user_token_purpose" ADD VALUE 'account_restore';`);
    expect(sql).toContain('CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");');
  });

  it('is additive only (no DROP, no data rewrite)', () => {
    const statements = sql.replace(/--.*$/gm, '');
    expect(statements).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
    expect(statements).not.toMatch(
      /\b(DROP\s+(COLUMN|CONSTRAINT|TABLE|TYPE|INDEX|VALUE)|ALTER\s+COLUMN|RENAME)\b/i,
    );
  });
});

describe('account deleted email', () => {
  it('has identical keys in English and Persian, and the Persian copy is Persian', () => {
    expect(Object.keys(ACCOUNT_DELETED_COPY.fa).sort()).toEqual(
      Object.keys(ACCOUNT_DELETED_COPY.en).sort(),
    );
    for (const value of Object.values(ACCOUNT_DELETED_COPY.fa)) {
      const text = typeof value === 'function' ? value('۶ دی ۱۴۰۵') : value;
      expect(text).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('restore link carries the token in the fragment; date in the reader’s calendar', () => {
    const { token } = issueSecretToken();
    const url = accountRestoreLink('https://app.example', 'fa', token);
    expect(url).toBe(`https://app.example/fa/auth/restore-account#token=${token}`);
    const date = new Date('2026-12-27T10:00:00Z');
    const faDate = formatPurgeDate(date, 'fa', 'Asia/Tehran', 'solar_hijri');
    expect(faDate).toMatch(/۱۴۰۵/); // Solar Hijri year in Persian digits
    const enDate = formatPurgeDate(date, 'en', 'America/New_York', 'gregorian');
    expect(enDate).toBe('December 27, 2026');
    // Unknown zone (should not happen: validated on write) falls back to UTC instead of throwing.
    expect(formatPurgeDate(date, 'en', 'Mars/Base', 'gregorian')).toBe('December 27, 2026');

    const fa = accountDeletedMessage({
      to: 'a@example.com',
      locale: 'fa',
      url,
      restoreUntil: faDate,
    });
    expect(fa).toMatchObject({ template: 'identity.account-deleted', locale: 'fa' });
    expect(fa.html).toContain('dir="rtl"');
    expect(fa.html).toContain(`href="${url}"`);
    expect(fa.text).toContain(faDate);
    const en = accountDeletedMessage({
      to: 'a@example.com',
      locale: 'en',
      url,
      restoreUntil: enDate,
    });
    expect(en.subject).toBe('Your account was deleted');
    expect(en.text).toContain('until December 27, 2026');
  });
});

describe('UserDataExportRegistry', () => {
  const contributor = (
    section: string,
    tables: UserDataContributor['tables'] = {},
  ): UserDataContributor => ({ section, tables, collect: () => Promise.resolve({}) });

  it('lists contributors by section name', () => {
    const registry = new UserDataExportRegistry();
    registry.register(contributor('tasks', { tasks: 'included' }));
    registry.register(contributor('account', { users: 'included' }));
    expect(registry.list().map((c) => c.section)).toEqual(['account', 'tasks']);
    expect([...registry.coveredTables()]).toEqual([
      ['tasks', 'tasks'],
      ['users', 'account'],
    ]);
  });

  it('refuses duplicate sections, bad names and a table claimed twice', () => {
    const registry = new UserDataExportRegistry();
    registry.register(contributor('account', { users: 'included' }));
    expect(() => registry.register(contributor('account'))).toThrow(/registered twice/);
    expect(() => registry.register(contributor('Bad-Name'))).toThrow(/Invalid/);
    expect(() => registry.register(contributor('other', { users: 'included' }))).toThrow(
      /claimed by data export sections "account" and "other"/,
    );
  });

  it('the identity contributor accounts for every identity table and excludes the password hash', () => {
    const identity = new IdentityDataExportContributor(new UserDataExportRegistry());
    expect(identity.section).toBe('account');
    expect(Object.keys(identity.tables).sort()).toEqual([
      'user_password_credentials',
      'user_preferences',
      'user_profiles',
      'user_security_events',
      'user_sessions',
      'user_tokens',
      'users',
    ]);
    expect(identity.tables.user_password_credentials).toHaveProperty('excluded');
  });
});
