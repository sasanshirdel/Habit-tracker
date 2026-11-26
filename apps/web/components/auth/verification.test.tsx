// @vitest-environment jsdom
import { UiProvider } from '@habit/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { Locale } from '@/lib/i18n/config';
import { formats } from '@/lib/i18n/formats';
import { messages } from '@/lib/i18n/messages';
import { AuthGate } from './auth-gate';
import { SignUpForm } from './sign-up-form';
import { VerifyEmail } from './verify-email';

// Backlog P2-04 (ADR-0021): the verification page, the unverified-account banner and the
// "check your email" sign-up confirmation.

vi.mock('@/lib/i18n/navigation', () => ({
  usePathname: () => '/overview',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  Link: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props} />
  ),
}));

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), publicPost: vi.fn() }));
vi.mock('@/lib/api/api', () => ({
  api: { get: http.get, post: http.post },
  publicApi: { post: http.publicPost },
  csrfTokens: { remember: vi.fn(), get: vi.fn(), forget: vi.fn() },
}));

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const USER = { id: '0190f3c4-0000-7000-8000-000000000001', email: 'sara@example.com' };

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  http.publicPost.mockReset();
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

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
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </UiProvider>
    </NextIntlClientProvider>,
  );
  return { queryClient };
}

const en = messages.en.auth;
const fa = messages.fa.auth;

describe('VerifyEmail page (P2-04)', () => {
  it('reads the token from the fragment, removes it from the address bar and verifies only on click', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/en/auth/verify-email#token=${TOKEN}`);
    http.publicPost.mockResolvedValue({ status: 'verified' });
    renderWith(<VerifyEmail />);
    const button = await screen.findByRole('button', { name: en.verifyEmail.confirm });
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/en/auth/verify-email');
    expect(http.publicPost).not.toHaveBeenCalled(); // opening the link changes nothing
    await user.click(button);
    const heading = await screen.findByRole('heading', { name: en.verifyEmail.verifiedTitle });
    expect(document.activeElement).toBe(heading);
    expect(http.publicPost).toHaveBeenCalledWith('/auth/verification/confirm', { token: TOKEN });
    expect(http.publicPost).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: en.verifyEmail.continue }).getAttribute('href')).toBe(
      '/auth/sign-in',
    );
    // Nothing kept in web storage.
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('a missing or malformed token goes straight to "this link doesn\'t work" without a request', async () => {
    for (const hash of ['', '#token=short', '#token=<b>x</b>']) {
      window.history.replaceState(null, '', `/fa/auth/verify-email${hash}`);
      renderWith(<VerifyEmail />, 'fa');
      expect(
        await screen.findByRole('heading', { name: fa.verifyEmail.invalidTitle }),
      ).toBeTruthy();
      expect(screen.getByRole('link', { name: fa.verifyEmail.signIn })).toBeTruthy();
      cleanup();
    }
    expect(http.publicPost).not.toHaveBeenCalled();
  });

  it('picks up a second link opened in the same tab (fragment change only)', async () => {
    window.history.replaceState(null, '', '/en/auth/verify-email');
    renderWith(<VerifyEmail />);
    expect(await screen.findByRole('heading', { name: en.verifyEmail.invalidTitle })).toBeTruthy();
    window.location.hash = `#token=${TOKEN}`;
    expect(await screen.findByRole('button', { name: en.verifyEmail.confirm })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe(''));
  });

  it('INVALID_TOKEN from the API → the same "this link doesn\'t work" state', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/en/auth/verify-email#token=${TOKEN}`);
    http.publicPost.mockRejectedValue(new ApiError('INVALID_TOKEN', 'bad', { status: 400 }));
    renderWith(<VerifyEmail />);
    await user.click(await screen.findByRole('button', { name: en.verifyEmail.confirm }));
    expect(await screen.findByRole('heading', { name: en.verifyEmail.invalidTitle })).toBeTruthy();
    expect(screen.getByText(en.verifyEmail.invalidBody)).toBeTruthy();
  });

  it('a network error keeps the button for a retry and says what happened', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/en/auth/verify-email#token=${TOKEN}`);
    http.publicPost
      .mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 'offline'))
      .mockResolvedValueOnce({ status: 'verified' });
    renderWith(<VerifyEmail />);
    await user.click(await screen.findByRole('button', { name: en.verifyEmail.confirm }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      messages.en.apiErrors.NETWORK_ERROR,
    );
    await user.click(screen.getByRole('button', { name: en.verifyEmail.confirm }));
    expect(await screen.findByRole('heading', { name: en.verifyEmail.verifiedTitle })).toBeTruthy();
  });
});

describe('unverified-account banner (P2-04)', () => {
  it('shows for an unverified account and sends a new link', async () => {
    const user = userEvent.setup();
    http.get.mockResolvedValue({ user: { ...USER, emailVerified: false }, csrfToken: 'c' });
    http.post.mockResolvedValue({ status: 'accepted' });
    renderWith(<AuthGate>page</AuthGate>);
    await screen.findByText('page');
    expect(
      screen.getByText(
        `We sent a confirmation link to \u2068${USER.email}\u2069. Open it to verify your address.`,
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: en.verifyBanner.resend }));
    expect(await screen.findByText(en.verifyBanner.sent)).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith('/auth/verification/resend');
  });

  it('says how long to wait when the per-account limit answers', async () => {
    const user = userEvent.setup();
    http.get.mockResolvedValue({ user: { ...USER, emailVerified: false }, csrfToken: 'c' });
    http.post.mockRejectedValue(
      new ApiError('RATE_LIMITED', 'slow down', {
        status: 429,
        retryAfterSeconds: 45,
        details: { retryAfterSeconds: 45, policy: 'verification-email' },
      }),
    );
    renderWith(<AuthGate>page</AuthGate>, 'fa');
    await screen.findByText('page');
    await user.click(screen.getByRole('button', { name: fa.verifyBanner.resend }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      fa.errors.resendTooSoon.replace(
        '{minutes, plural, one {# دقیقه} other {# دقیقه}}',
        '۱ دقیقه',
      ),
    );
  });

  it('is absent for a verified account', async () => {
    http.get.mockResolvedValue({ user: { ...USER, emailVerified: true }, csrfToken: 'c' });
    renderWith(<AuthGate>page</AuthGate>);
    await screen.findByText('page');
    expect(screen.queryByRole('button', { name: en.verifyBanner.resend })).toBeNull();
  });
});

describe('sign-up confirmation (P2-04)', () => {
  it('says "check your email" and names the (normalised) address, isolated for bidi', async () => {
    const user = userEvent.setup();
    http.publicPost.mockResolvedValue({ status: 'accepted' });
    renderWith(<SignUpForm next={null} />, 'fa');
    await user.type(screen.getByLabelText(fa.fields.email), 'New@Example.com');
    await user.type(screen.getByLabelText(fa.fields.password), 'a long pass phrase');
    await user.click(screen.getByRole('button', { name: fa.signUp.submit }));
    expect(await screen.findByRole('heading', { name: fa.signUp.acceptedTitle })).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByText(fa.signUp.acceptedBody.replace('{email}', '\u2068new@example.com\u2069')),
      ).toBeTruthy(),
    );
  });
});
