// @vitest-environment jsdom
import type { AccountSession, SecurityEvent, UserPreferences } from '@habit/shared-types';
import { Toaster, UiProvider } from '@habit/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { Locale } from '@/lib/i18n/config';
import { formats } from '@/lib/i18n/formats';
import { messages } from '@/lib/i18n/messages';
import { SecuritySettings } from './security-settings';

// Backlog P2-08 (ADR-0023): Settings → Sessions and security.

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/api', () => ({
  api: { get: http.get, post: http.post, delete: http.delete },
  publicApi: { post: vi.fn() },
  csrfTokens: { remember: vi.fn(), get: vi.fn(), forget: vi.fn() },
}));

const NOW = Date.now();
const CURRENT: AccountSession = {
  id: '0190f3c4-0000-7000-8000-000000000001',
  current: true,
  client: { browser: 'chrome', os: 'windows', device: 'desktop' },
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  lastActiveAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
};
const PHONE: AccountSession = {
  id: '0190f3c4-0000-7000-8000-000000000002',
  current: false,
  client: { browser: 'firefox', os: 'android', device: 'mobile' },
  createdAt: new Date(NOW - 7_200_000).toISOString(),
  lastActiveAt: new Date(NOW - 1_800_000).toISOString(),
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
};
const EVENT: SecurityEvent = {
  id: '0190f3c4-0000-7000-8000-0000000000aa',
  type: 'sign_in',
  occurredAt: new Date(NOW - 3_600_000).toISOString(),
  client: { browser: 'chrome', os: 'windows', device: 'desktop' },
};
const page = <T,>(data: T[]) => ({
  data,
  page: { nextCursor: null, hasMore: false, limit: 20 },
});

const UTC_GREGORIAN: UserPreferences = {
  locale: 'en',
  timezone: 'UTC',
  theme: 'dark',
  calendar: 'gregorian',
  weekStart: 'monday',
};

function routeGets(
  sessions: AccountSession[],
  events: SecurityEvent[],
  preferences: UserPreferences = UTC_GREGORIAN,
) {
  http.get.mockImplementation(async (path: string) => {
    if (path === '/account/preferences') return preferences;
    if (path.startsWith('/account/sessions')) return page(sessions);
    if (path.startsWith('/account/security-events')) return page(events);
    throw new Error(`unexpected GET ${path}`);
  });
}

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  http.delete.mockReset();
});
afterEach(cleanup);

function renderWith(locale: Locale = 'en') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages[locale]}
      formats={formats}
      timeZone="UTC"
    >
      <UiProvider dir={locale === 'fa' ? 'rtl' : 'ltr'}>
        <QueryClientProvider client={queryClient}>
          <SecuritySettings />
          <Toaster label="n" regionLabel="Notifications" closeLabel="Close" />
        </QueryClientProvider>
      </UiProvider>
    </NextIntlClientProvider>,
  );
  return { queryClient };
}

const en = messages.en.settings.security;
/** "{browser} on {os}" with first-strong isolates around the product names. */
const iso = (browser: string, os: string, joiner: string) =>
  `\u2068${browser}\u2069 ${joiner} \u2068${os}\u2069`;
const fa = messages.fa.settings.security;

describe('SecuritySettings (P2-08)', () => {
  it('shows times in the profile time zone and calendar (P2-07)', async () => {
    routeGets([CURRENT], [EVENT], {
      ...UTC_GREGORIAN,
      timezone: 'Asia/Tehran',
      calendar: 'solar_hijri',
    });
    renderWith();
    const expected = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Tehran',
      calendar: 'persian',
    }).format(new Date(EVENT.occurredAt));
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(http.get).toHaveBeenCalledWith('/account/preferences', expect.anything());
  });

  it('lists sessions with the current one marked and only others revocable; shows activity', async () => {
    routeGets([PHONE, CURRENT], [EVENT]);
    renderWith();
    expect(await screen.findByText(iso('Firefox', 'Android', 'on'))).toBeTruthy();
    expect(screen.getAllByText(iso('Chrome', 'Windows', 'on')).length).toBeGreaterThan(0);
    expect(screen.getByText(en.sessions.thisDevice)).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${en.sessions.activeNow} · `))).toBeTruthy();
    // One per-device sign-out button (the phone), with a descriptive accessible name.
    const revokeButtons = screen.getAllByRole('button', { name: /^Sign out \u2068Firefox/ });
    expect(revokeButtons).toHaveLength(1);
    expect(screen.getByRole('button', { name: en.sessions.revokeOthers })).toBeTruthy();
    expect(await screen.findByText(en.activity.events.sign_in)).toBeTruthy();
    expect(http.get).toHaveBeenCalledWith('/account/sessions?limit=20', expect.anything());
  });

  it('confirms before signing out a device, then refreshes both lists', async () => {
    const user = userEvent.setup();
    routeGets([PHONE, CURRENT], [EVENT]);
    http.delete.mockResolvedValue(undefined);
    renderWith();
    await user.click(await screen.findByRole('button', { name: /^Sign out \u2068Firefox/ }));
    const dialog = await screen.findByRole('dialog', { name: en.sessions.revokeTitle });
    expect(http.delete).not.toHaveBeenCalled();
    routeGets(
      [CURRENT],
      [{ ...EVENT, id: `${EVENT.id.slice(0, -2)}bb`, type: 'session_revoked' }, EVENT],
    );
    await user.click(within(dialog).getByRole('button', { name: en.sessions.revokeConfirm }));
    await waitFor(() => expect(http.delete).toHaveBeenCalledWith(`/account/sessions/${PHONE.id}`));
    expect(await screen.findByText(en.sessions.revoked)).toBeTruthy();
    expect(await screen.findByText(en.activity.events.session_revoked)).toBeTruthy();
    expect(await screen.findByText(en.sessions.onlyThisDevice)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.sessions.revokeOthers })).toBeNull();
    // The button that opened the dialog left with its row: focus goes to the list heading
    // instead of falling to the page body (P2-09).
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: en.sessions.title })),
    );
  });

  it('signs out all other devices and reports how many', async () => {
    const user = userEvent.setup();
    routeGets([PHONE, CURRENT], [EVENT]);
    http.post.mockResolvedValue({ revoked: 1 });
    renderWith();
    await user.click(await screen.findByRole('button', { name: en.sessions.revokeOthers }));
    const dialog = await screen.findByRole('dialog', { name: en.sessions.revokeOthersTitle });
    await user.click(within(dialog).getByRole('button', { name: en.sessions.revokeOthersConfirm }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/account/sessions/revoke-others'));
    expect(await screen.findByText('1 device was signed out.')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: en.sessions.title })),
    );
  });

  it('cancelling a confirmation returns focus to the button that opened it', async () => {
    const user = userEvent.setup();
    routeGets([PHONE, CURRENT], [EVENT]);
    renderWith();
    const others = await screen.findByRole('button', { name: en.sessions.revokeOthers });
    await user.click(others);
    expect(await screen.findByRole('dialog', { name: en.sessions.revokeOthersTitle })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(others);
    const one = screen.getByRole('button', { name: /^Sign out \u2068Firefox/ });
    await user.click(one);
    const dialog = await screen.findByRole('dialog', { name: en.sessions.revokeTitle });
    await user.click(within(dialog).getAllByRole('button', { name: en.sessions.cancel }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(one);
  });

  it('a failed revocation keeps the dialog open and says so', async () => {
    const user = userEvent.setup();
    routeGets([PHONE, CURRENT], []);
    http.delete.mockRejectedValue(new ApiError('NOT_FOUND', 'x', { status: 404 }));
    renderWith();
    await user.click(await screen.findByRole('button', { name: /^Sign out \u2068Firefox/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: en.sessions.revokeConfirm }));
    expect(await screen.findByText(en.sessions.revokeFailed)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows the error state with retry when a list fails, and the empty activity state', async () => {
    http.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/account/sessions')) {
        throw new ApiError('INTERNAL_ERROR', 'x', { status: 500, requestId: 'r-1' });
      }
      return page([]);
    });
    renderWith();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(await screen.findByText(en.activity.empty)).toBeTruthy();
  });

  it('renders in Persian with isolated product names', async () => {
    routeGets([PHONE, CURRENT], [EVENT]);
    renderWith('fa');
    expect(await screen.findByRole('heading', { name: fa.sessions.title })).toBeTruthy();
    expect(await screen.findByText('\u2068Firefox\u2069 روی \u2068Android\u2069')).toBeTruthy();
    expect(screen.getByText(fa.sessions.thisDevice)).toBeTruthy();
  });
});
