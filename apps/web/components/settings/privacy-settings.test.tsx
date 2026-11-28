// @vitest-environment jsdom
import { Toaster, UiProvider } from '@habit/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestoreAccount } from '@/components/auth/restore-account';
import { AuthGate } from '@/components/auth/auth-gate';
import { exportFileName } from '@/lib/account/privacy';
import { ApiError } from '@/lib/api/errors';
import { sessionQueryKey, type SessionState } from '@/lib/auth/session';
import type { Locale } from '@/lib/i18n/config';
import { formats } from '@/lib/i18n/formats';
import { messages } from '@/lib/i18n/messages';
import { PrivacySettings } from './privacy-settings';

// Backlog P2-10 (ADR-0025): Settings → Your data (export, deletion) and the restore page.

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/i18n/navigation', () => ({
  usePathname: () => '/settings/privacy',
  useRouter: () => router,
  Link: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props} />
  ),
}));

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), publicPost: vi.fn() }));
const csrf = vi.hoisted(() => ({ remember: vi.fn(), get: vi.fn(), forget: vi.fn() }));
vi.mock('@/lib/api/api', () => ({
  api: { get: http.get, post: http.post },
  publicApi: { post: http.publicPost },
  csrfTokens: csrf,
}));

const EMAIL = 'sara@example.com';
const SIGNED_IN: SessionState = {
  status: 'signed-in',
  user: { id: '0190f3c4-0000-7000-8000-000000000001', email: EMAIL, emailVerified: true },
};
const PASSWORD = 'correct horse battery staple';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const EXPORT = {
  format: 'habit-tracker.user-data-export',
  version: 1,
  exportedAt: '2026-11-27T10:00:00.000Z',
  sections: { account: { user: { email: EMAIL } } },
};

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  http.publicPost.mockReset();
  router.replace.mockReset();
  csrf.remember.mockReset();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

function renderWith(ui: ReactNode, locale: Locale = 'en') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData<SessionState>(sessionQueryKey, () => SIGNED_IN);
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
  return { queryClient };
}

const en = messages.en.settings.privacy;
const fa = messages.fa.settings.privacy;

describe('PrivacySettings — export (P2-10)', () => {
  it('posts the export and saves the JSON as a file named by date', async () => {
    const user = userEvent.setup();
    http.post.mockResolvedValue(EXPORT);
    const createUrl = vi.fn(() => 'blob:export');
    const revokeUrl = vi.fn();
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this);
    });
    renderWith(<PrivacySettings />);
    await user.click(screen.getByRole('button', { name: en.export.download }));
    expect(await screen.findByText(en.export.done)).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith('/account/export');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.download).toBe('habit-tracker-data-2026-11-27.json');
    expect(clicks[0]!.getAttribute('href')).toBe('blob:export');
    const blob = (createUrl.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text())).toEqual(EXPORT);
    expect(document.querySelector('a[download]')).toBeNull(); // temporary link removed
    expect(exportFileName('2026-01-02T23:59:59.000Z')).toBe('habit-tracker-data-2026-01-02.json');
  });

  it('reports a failed export', async () => {
    const user = userEvent.setup();
    http.post.mockRejectedValue(new ApiError('RATE_LIMITED', 'x', { status: 429 }));
    renderWith(<PrivacySettings />);
    await user.click(screen.getByRole('button', { name: en.export.download }));
    expect(await screen.findByText(en.export.failed)).toBeTruthy();
  });
});

describe('PrivacySettings — deletion (P2-10)', () => {
  async function openDialog() {
    const user = userEvent.setup();
    renderWith(<PrivacySettings />);
    expect(screen.getByText(/30 days/)).toBeTruthy(); // grace period stated up front
    await user.click(screen.getByRole('button', { name: en.delete.open }));
    const dialog = await screen.findByRole('dialog', { name: en.delete.dialogTitle });
    return { user, dialog };
  }

  it('needs the password and the typed email address before anything is sent', async () => {
    const { user } = await openDialog();
    await user.click(screen.getByRole('button', { name: en.delete.confirm }));
    expect(await screen.findByText(en.delete.passwordRequired)).toBeTruthy();
    expect(screen.getByText(en.delete.confirmMismatch)).toBeTruthy();
    expect(screen.getByLabelText(en.delete.password).getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText(en.delete.password));
    await user.type(screen.getByLabelText(en.delete.password), PASSWORD);
    await user.type(screen.getByLabelText(en.delete.confirmLabel), 'sara@example.co');
    await user.click(screen.getByRole('button', { name: en.delete.confirm }));
    expect(screen.getByText(en.delete.confirmMismatch)).toBeTruthy();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('closing the dialog (Escape or Cancel) returns focus to "Delete account…" (WAI-ARIA dialog)', async () => {
    for (const locale of ['en', 'fa'] as const) {
      const t = messages[locale].settings.privacy.delete;
      const user = userEvent.setup();
      renderWith(<PrivacySettings />, locale);
      const open = screen.getByRole('button', { name: t.open });
      open.focus();
      await user.keyboard('{Enter}');
      expect(await screen.findByRole('dialog', { name: t.dialogTitle })).toBeTruthy();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(open);
      await user.click(open);
      const dialog = await screen.findByRole('dialog', { name: t.dialogTitle });
      const cancel = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent === t.cancel,
      )!;
      await user.click(cancel);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(open);
      cleanup();
    }
  });

  it('a wrong password keeps the user signed in and says so', async () => {
    const { user } = await openDialog();
    http.post.mockRejectedValue(new ApiError('REAUTHENTICATION_FAILED', 'x', { status: 403 }));
    await user.type(screen.getByLabelText(en.delete.password), 'wrong');
    await user.type(screen.getByLabelText(en.delete.confirmLabel), ` ${EMAIL.toUpperCase()} `);
    await user.click(screen.getByRole('button', { name: en.delete.confirm }));
    expect(await screen.findByText(messages.en.apiErrors.REAUTHENTICATION_FAILED)).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith('/account/deletion', { password: 'wrong' });
    expect((screen.getByLabelText(en.delete.password) as HTMLInputElement).value).toBe('');
    expect(csrf.remember).not.toHaveBeenCalled();
  });

  it('on success drops local state and AuthGate goes to the confirmation page', async () => {
    const user = userEvent.setup();
    http.post.mockResolvedValue({
      status: 'deletion-scheduled',
      purgeAfter: '2026-12-27T10:00:00.000Z',
    });
    const { queryClient } = renderWith(
      <AuthGate>
        <PrivacySettings />
      </AuthGate>,
    );
    queryClient.setQueryData(['account', 'profile'], { displayName: 'Sara' });
    await user.click(screen.getByRole('button', { name: en.delete.open }));
    await user.type(await screen.findByLabelText(en.delete.password), PASSWORD);
    await user.type(screen.getByLabelText(en.delete.confirmLabel), EMAIL);
    await user.click(screen.getByRole('button', { name: en.delete.confirm }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/auth/account-deleted'));
    expect(http.post).toHaveBeenCalledWith('/account/deletion', { password: PASSWORD });
    expect(csrf.remember).toHaveBeenCalledWith(null);
    expect(queryClient.getQueryData(['account', 'profile'])).toBeUndefined();
    expect(queryClient.getQueryData(sessionQueryKey)).toEqual({
      status: 'signed-out',
      reason: 'account-deleted',
    });
  });

  it('Persian: the same flow in RTL with the address isolated', async () => {
    const user = userEvent.setup();
    renderWith(<PrivacySettings />, 'fa');
    expect(screen.getByRole('heading', { name: fa.export.title })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: fa.delete.open }));
    expect(await screen.findByRole('dialog', { name: fa.delete.dialogTitle })).toBeTruthy();
    expect(screen.getByText(`بنویسید: \u2068${EMAIL}\u2069`)).toBeTruthy();
    expect(screen.getByLabelText(fa.delete.confirmLabel).getAttribute('dir')).toBe('ltr');
  });
});

describe('RestoreAccount page (P2-10)', () => {
  const rt = messages.en.auth.restoreAccount;

  it('reads the token from the fragment and restores only on click', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/en/auth/restore-account#token=${TOKEN}`);
    http.publicPost.mockResolvedValue({ status: 'restored' });
    renderWith(<RestoreAccount />);
    const button = await screen.findByRole('button', { name: rt.confirm });
    expect(window.location.hash).toBe('');
    expect(http.publicPost).not.toHaveBeenCalled();
    await user.click(button);
    const heading = await screen.findByRole('heading', { name: rt.restoredTitle });
    expect(document.activeElement).toBe(heading);
    expect(http.publicPost).toHaveBeenCalledWith('/auth/account-restore', { token: TOKEN });
    expect(screen.getByRole('link', { name: rt.signIn }).getAttribute('href')).toBe(
      '/auth/sign-in',
    );
  });

  it('a dead or missing link shows one message with the grace period', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/en/auth/restore-account#token=${TOKEN}`);
    http.publicPost.mockRejectedValue(new ApiError('INVALID_TOKEN', 'x', { status: 400 }));
    renderWith(<RestoreAccount />);
    await user.click(await screen.findByRole('button', { name: rt.confirm }));
    expect(await screen.findByRole('heading', { name: rt.invalidTitle })).toBeTruthy();
    expect(screen.getByText(/within 30 days/)).toBeTruthy();
    cleanup();
    window.history.replaceState(null, '', '/en/auth/restore-account');
    renderWith(<RestoreAccount />);
    expect(await screen.findByRole('heading', { name: rt.invalidTitle })).toBeTruthy();
  });
});
