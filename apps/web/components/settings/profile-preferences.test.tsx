// @vitest-environment jsdom
import type { UserPreferences } from '@habit/shared-types';
import { themePreferenceSchema } from '@habit/shared-validation';
import { Toaster, UiProvider, themePreferences } from '@habit/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { Locale } from '@/lib/i18n/config';
import { formats } from '@/lib/i18n/formats';
import { messages } from '@/lib/i18n/messages';
import { PreferencesSettings } from './preferences-settings';
import { ProfileSettings } from './profile-settings';

// Backlog P2-07 (ADR-0024): Settings → Profile and Settings → Preferences.

const nav = vi.hoisted(() => ({ pathname: '/settings/preferences', replace: vi.fn() }));
vi.mock('@/lib/i18n/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
}));

const http = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/api', () => ({
  api: { get: http.get, patch: http.patch },
  publicApi: { post: vi.fn() },
  csrfTokens: { remember: vi.fn(), get: vi.fn(), forget: vi.fn() },
}));

const PREFS: UserPreferences = {
  locale: 'en',
  timezone: 'Asia/Tehran',
  theme: 'dark',
  calendar: 'gregorian',
  weekStart: 'monday',
};

beforeEach(() => {
  http.get.mockReset();
  http.patch.mockReset();
  nav.replace.mockReset();
  document.documentElement.dataset.theme = 'dark';
  document.cookie = 'theme=; Max-Age=0; Path=/';
  http.get.mockImplementation(async (path: string) => {
    if (path === '/account/profile') return { displayName: 'Sara' };
    if (path === '/account/preferences') return PREFS;
    throw new Error(`unexpected GET ${path}`);
  });
});
afterEach(cleanup);

function renderWith(ui: ReactNode, locale: Locale = 'en') {
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
          {ui}
          <Toaster label="n" regionLabel="Notifications" closeLabel="Close" />
        </QueryClientProvider>
      </UiProvider>
    </NextIntlClientProvider>,
  );
}

const enProfile = messages.en.settings.profile;
const enPrefs = messages.en.settings.preferences;

describe('ProfileSettings (P2-07)', () => {
  it('loads the display name and saves the normalised value the API returns', async () => {
    const user = userEvent.setup();
    http.patch.mockResolvedValue({ displayName: 'Sara Ahmadi' });
    renderWith(<ProfileSettings />);
    const input = await screen.findByRole('textbox', { name: enProfile.displayName });
    expect((input as HTMLInputElement).value).toBe('Sara');
    expect(input.getAttribute('dir')).toBe('auto');
    const save = screen.getByRole('button', { name: enProfile.save });
    expect((save as HTMLButtonElement).disabled).toBe(true); // nothing changed yet

    await user.clear(input);
    await user.type(input, '  Sara   Ahmadi ');
    await user.click(save);
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/account/profile', { displayName: 'Sara Ahmadi' }),
    );
    expect(await screen.findByText(enProfile.saved)).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('Sara Ahmadi');
  });

  it('blocks a too-long name with a linked, localised error and sends nothing', async () => {
    const user = userEvent.setup();
    renderWith(<ProfileSettings />);
    const input = await screen.findByRole('textbox', { name: enProfile.displayName });
    await user.clear(input);
    await user.type(input, 'x'.repeat(101));
    await user.click(screen.getByRole('button', { name: enProfile.save }));
    const error = await screen.findByText('Use at most 100 characters.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
    expect(http.patch).not.toHaveBeenCalled();
  });

  it('shows the API error in the form (Persian)', async () => {
    const user = userEvent.setup();
    http.patch.mockRejectedValue(
      new ApiError('RATE_LIMITED', 'Too many requests', { status: 429, retryAfterSeconds: 30 }),
    );
    renderWith(<ProfileSettings />, 'fa');
    const input = await screen.findByRole('textbox', {
      name: messages.fa.settings.profile.displayName,
    });
    await user.type(input, ' احمدی');
    await user.click(screen.getByRole('button', { name: messages.fa.settings.profile.save }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('PreferencesSettings (P2-07)', () => {
  it('theme options are the shared schema’s values', () => {
    expect([...themePreferences]).toEqual(themePreferenceSchema.options);
  });

  it('shows the saved values and sends only what changed; theme applies at once', async () => {
    const user = userEvent.setup();
    http.patch.mockResolvedValue({ ...PREFS, theme: 'light', weekStart: 'saturday' });
    renderWith(<PreferencesSettings />);
    const theme = await screen.findByRole('combobox', { name: messages.en.theme.label });
    const zone = screen.getByRole('combobox', { name: enPrefs.timeZone }) as HTMLSelectElement;
    expect(zone.value).toBe('Asia/Tehran');
    expect(zone.getAttribute('dir')).toBe('ltr');
    expect(
      (screen.getByRole('combobox', { name: enPrefs.calendar }) as HTMLSelectElement).value,
    ).toBe('gregorian');

    await user.selectOptions(theme, 'light');
    await user.selectOptions(screen.getByRole('combobox', { name: enPrefs.weekStart }), 'saturday');
    await user.click(screen.getByRole('button', { name: enPrefs.save }));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/account/preferences', {
        theme: 'light',
        weekStart: 'saturday',
      }),
    );
    expect(await screen.findByText(enPrefs.saved)).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.cookie).toContain('theme=light');
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('a new language switches the route to that locale', async () => {
    const user = userEvent.setup();
    http.patch.mockResolvedValue({ ...PREFS, locale: 'fa' });
    renderWith(<PreferencesSettings />);
    const language = await screen.findByRole('combobox', { name: enPrefs.language });
    expect(screen.getByRole('option', { name: 'فارسی' }).getAttribute('lang')).toBe('fa');
    await user.selectOptions(language, 'fa');
    await user.click(screen.getByRole('button', { name: enPrefs.save }));
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith('/settings/preferences', { locale: 'fa' }),
    );
    expect(http.patch).toHaveBeenCalledWith('/account/preferences', { locale: 'fa' });
  });

  it('renders in Persian with Persian option labels', async () => {
    renderWith(<PreferencesSettings />, 'fa');
    const fa = messages.fa.settings.preferences;
    const calendar = await screen.findByRole('combobox', { name: fa.calendar });
    expect(calendar.textContent).toContain(fa.calendars.solar_hijri);
    expect(screen.getByRole('combobox', { name: fa.weekStart }).textContent).toContain(
      fa.weekdays.saturday,
    );
  });

  it('shows a load failure with a retry', async () => {
    http.get.mockRejectedValue(new ApiError('NETWORK_ERROR', 'offline'));
    renderWith(<PreferencesSettings />);
    expect(await screen.findByRole('button', { name: messages.en.apiErrors.retry })).toBeTruthy();
  });
});
