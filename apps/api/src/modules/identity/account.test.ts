import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLIENT_BROWSERS,
  CLIENT_DEVICES,
  CLIENT_OSES,
  ENDED_SESSION_RETENTION_DAYS,
  SECURITY_EVENT_RETENTION_DAYS,
  SECURITY_EVENT_TYPES,
  type AccountSession,
  type AccountSessionList,
  type RevokeOtherSessionsResponse,
  type SecurityEvent,
  type SecurityEventList,
} from '@habit/shared-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  accountListQuerySchema,
  accountSessionListSchema,
  accountSessionSchema,
  idCursorSchema,
  revokeOtherSessionsResponseSchema,
  securityEventListSchema,
  securityEventSchema,
} from './account.schemas.js';
import { describeUserAgent, UNKNOWN_CLIENT } from './client-description.js';
import { SECURITY_EVENT_RETENTION_MS } from './security-events.service.js';
import { ENDED_SESSION_RETENTION_MS } from './session.service.js';

// Real-world User-Agent strings (shortened only where irrelevant), classified coarsely (P2-08).
const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1',
  chromeIpad:
    'Mozilla/5.0 (iPad; CPU OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/145.0 Mobile/15E148 Safari/605.1.15',
  chromeAndroidPhone:
    'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  chromeAndroidTablet:
    'Mozilla/5.0 (Linux; Android 16; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 16; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  headlessShell:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36',
} as const;

describe('describeUserAgent (P2-08, ADR-0023)', () => {
  it.each([
    ['chromeWindows', 'chrome', 'windows', 'desktop'],
    ['edgeWindows', 'edge', 'windows', 'desktop'],
    ['firefoxLinux', 'firefox', 'linux', 'desktop'],
    ['safariMac', 'safari', 'macos', 'desktop'],
    ['safariIphone', 'safari', 'ios', 'mobile'],
    ['chromeIpad', 'chrome', 'ios', 'tablet'],
    ['firefoxIos', 'firefox', 'ios', 'mobile'],
    ['chromeAndroidPhone', 'chrome', 'android', 'mobile'],
    ['chromeAndroidTablet', 'chrome', 'android', 'tablet'],
    ['samsungAndroid', 'samsung_internet', 'android', 'mobile'],
    ['operaWindows', 'opera', 'windows', 'desktop'],
    ['chromeOs', 'chrome', 'chromeos', 'desktop'],
    ['headlessShell', 'unknown', 'linux', 'desktop'],
  ] as const)('%s → %s / %s / %s', (key, browser, os, device) => {
    expect(describeUserAgent(UA[key])).toEqual({ browser, os, device });
  });

  it('missing, empty and unrecognised values are unknown', () => {
    expect(describeUserAgent(undefined)).toEqual(UNKNOWN_CLIENT);
    expect(describeUserAgent(null)).toEqual(UNKNOWN_CLIENT);
    expect(describeUserAgent('   ')).toEqual(UNKNOWN_CLIENT);
    expect(describeUserAgent('curl/8.11.0')).toEqual(UNKNOWN_CLIENT);
  });

  it('returns only the three coarse families — never versions or the raw string', () => {
    const result = describeUserAgent(UA.chromeWindows);
    expect(Object.keys(result).sort()).toEqual(['browser', 'device', 'os']);
    expect(JSON.stringify(result)).not.toMatch(/\d/);
    expect(CLIENT_BROWSERS).toContain(result.browser);
    expect(CLIENT_OSES).toContain(result.os);
    expect(CLIENT_DEVICES).toContain(result.device);
  });

  it('stays fast on hostile, oversized input', () => {
    const hostile = `Version/1 ${'Safari/ '.repeat(20_000)}`;
    const started = performance.now();
    describeUserAgent(hostile);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('account contracts (P2-08)', () => {
  it('response schemas mirror @habit/shared-types', () => {
    expectTypeOf<z.output<typeof accountSessionSchema>>().toEqualTypeOf<AccountSession>();
    expectTypeOf<z.output<typeof accountSessionListSchema>>().toEqualTypeOf<AccountSessionList>();
    expectTypeOf<
      z.output<typeof revokeOtherSessionsResponseSchema>
    >().toEqualTypeOf<RevokeOtherSessionsResponse>();
    expectTypeOf<z.output<typeof securityEventSchema>>().toEqualTypeOf<SecurityEvent>();
    expectTypeOf<z.output<typeof securityEventListSchema>>().toEqualTypeOf<SecurityEventList>();
  });

  it('list query: limit default/maximum, no unknown parameters', () => {
    expect(accountListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(accountListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(accountListQuerySchema.safeParse({ userId: 'x' }).success).toBe(false);
    expect(idCursorSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });

  it('retention constants', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(SECURITY_EVENT_RETENTION_MS).toBe(SECURITY_EVENT_RETENTION_DAYS * day);
    expect(ENDED_SESSION_RETENTION_MS).toBe(ENDED_SESSION_RETENTION_DAYS * day);
  });
});

// The enums exist three times — shared-types (wire), Prisma schema (types), migration SQL
// (database). Keep them identical.
const migrationsDir = resolve(import.meta.dirname, '../../../prisma/migrations');
const migration = readdirSync(migrationsDir).find((d) =>
  d.endsWith('_session_metadata_security_events'),
);
const sql = readFileSync(resolve(migrationsDir, migration ?? 'missing', 'migration.sql'), 'utf8');

describe('session metadata / security events migration (P2-08)', () => {
  it('database enums equal the shared contract values', async () => {
    const enums = await import('../../generated/prisma/enums.js');
    expect(Object.values(enums.ClientBrowser)).toEqual([...CLIENT_BROWSERS]);
    expect(Object.values(enums.ClientOs)).toEqual([...CLIENT_OSES]);
    expect(Object.values(enums.ClientDevice)).toEqual([...CLIENT_DEVICES]);
    expect(Object.values(enums.SecurityEventType)).toEqual([...SECURITY_EVENT_TYPES]);
    // P2-10 added values with ALTER TYPE … ADD VALUE (see privacy.test.ts); the P2-08 migration
    // created the first seven.
    const p208Types = SECURITY_EVENT_TYPES.slice(0, 7);
    const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
    expect(sql).toContain(`"client_browser" AS ENUM (${quoted(CLIENT_BROWSERS)})`);
    expect(sql).toContain(`"client_os" AS ENUM (${quoted(CLIENT_OSES)})`);
    expect(sql).toContain(`"client_device" AS ENUM (${quoted(CLIENT_DEVICES)})`);
    expect(sql).toContain(`"security_event_type" AS ENUM (${quoted(p208Types)})`);
  });

  it('is additive only (no DROP, no data rewrite)', () => {
    const statements = sql.replace(/--.*$/gm, '');
    expect(statements).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE|UPDATE)\b/im);
    expect(statements).not.toMatch(
      /\b(DROP\s+(COLUMN|CONSTRAINT|TABLE|TYPE|INDEX|VALUE)|ALTER\s+COLUMN|RENAME)\b/i,
    );
    // New columns on the existing table must have a default so old rows stay valid.
    for (const line of statements.match(/ADD COLUMN[^,;]*/g) ?? []) {
      expect(line).toMatch(/NOT NULL DEFAULT 'unknown'/);
    }
  });

  it('stores no IP address or raw user agent', () => {
    expect(sql).not.toMatch(/\b(ip|ip_address|user_agent|inet)\b/i);
  });
});
