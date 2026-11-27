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
import { ForgotPasswordForm } from './forgot-password-form';
import { ResetPasswordForm, resetFormSchema } from './reset-password-form';
import { SignInForm } from './sign-in-form';

// Backlog P2-05 (ADR-0022): the forgot-password and reset-password pages, and the sign-in link.

vi.mock('@/lib/i18n/navigation', () => ({
  usePathname: () => '/auth/sign-in',
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
const NEW_PASSWORD = 'a long new pass phrase';

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

describe('sign-in page link (P2-05)', () => {
  it('offers "Forgot your password?"', async () => {
    http.get.mockRejectedValue(new ApiError('UNAUTHENTICATED', 'no', { status: 401 }));
    renderWith(<SignInForm next={null} />);
    const link = await screen.findByRole('link', { name: en.signIn.forgotPassword });
    expect(link.getAttribute('href')).toBe('/auth/forgot-password');
  });
});

describe('ForgotPasswordForm (P2-05)', () => {
  it('posts the normalised address and confirms neutrally (no enumeration), focus on the heading', async () => {
    const user = userEvent.setup();
    http.publicPost.mockResolvedValue({ status: 'accepted' });
    renderWith(<ForgotPasswordForm />, 'fa');
    await user.type(screen.getByLabelText(fa.fields.email), ' Sara@Example.COM ');
    await user.click(screen.getByRole('button', { name: fa.forgotPassword.submit }));
    const heading = await screen.findByRole('heading', { name: fa.forgotPassword.sentTitle });
    expect(document.activeElement).toBe(heading);
    expect(http.publicPost).toHaveBeenCalledWith('/auth/password-reset/request', {
      email: 'sara@example.com',
    });
    const body = fa.forgotPassword.sentBody
      .replace('{email}', '\u2068sara@example.com\u2069')
      .replace('{minutes, number}', '۳۰');
    await waitFor(() => expect(screen.getByText(body)).toBeTruthy());
    expect(screen.getByRole('link', { name: fa.forgotPassword.backToSignIn })).toBeTruthy();
  });

  it('validates the address before sending', async () => {
    const user = userEvent.setup();
    renderWith(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText(en.fields.email), 'not-an-address');
    await user.click(screen.getByRole('button', { name: en.forgotPassword.submit }));
    expect(await screen.findByText(en.validation.emailInvalid)).toBeTruthy();
    expect(http.publicPost).not.toHaveBeenCalled();
  });

  it('a device rate limit says how long to wait and keeps the form', async () => {
    const user = userEvent.setup();
    http.publicPost.mockRejectedValue(
      new ApiError('RATE_LIMITED', 'slow', {
        status: 429,
        retryAfterSeconds: 120,
        details: { retryAfterSeconds: 120, policy: 'auth' },
      }),
    );
    renderWith(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText(en.fields.email), 'sara@example.com');
    await user.click(screen.getByRole('button', { name: en.forgotPassword.submit }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many attempts from this device. Wait 2 minutes and try again.',
    );
    expect(screen.getByRole('button', { name: en.forgotPassword.submit })).toBeTruthy();
  });
});

describe('ResetPasswordForm (P2-05)', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, password: string, confirm: string) {
    if (password) await user.type(screen.getByLabelText(en.fields.newPassword), password);
    if (confirm) await user.type(screen.getByLabelText(en.fields.confirmPassword), confirm);
    await user.click(screen.getByRole('button', { name: en.resetPassword.submit }));
  }

  it('reads the token from the fragment, removes it, and resets only when the button is pressed', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/en/auth/reset-password#token=${TOKEN}`);
    http.publicPost.mockResolvedValue({ status: 'password-reset' });
    const { queryClient } = renderWith(<ResetPasswordForm />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByRole('button', { name: en.resetPassword.submit });
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/en/auth/reset-password');
    expect(http.publicPost).not.toHaveBeenCalled();
    await fill(user, NEW_PASSWORD, NEW_PASSWORD);
    const heading = await screen.findByRole('heading', { name: en.resetPassword.doneTitle });
    expect(document.activeElement).toBe(heading);
    expect(http.publicPost).toHaveBeenCalledWith('/auth/password-reset/confirm', {
      token: TOKEN,
      password: NEW_PASSWORD,
    });
    expect(http.publicPost).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalled(); // the session is re-checked (all sessions ended)
    expect(screen.getByRole('link', { name: en.resetPassword.signIn }).getAttribute('href')).toBe(
      '/auth/sign-in',
    );
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('checks the policy and that both fields match before sending', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/en/auth/reset-password#token=${TOKEN}`);
    renderWith(<ResetPasswordForm />);
    await screen.findByRole('button', { name: en.resetPassword.submit });
    await fill(user, 'short', '');
    expect(await screen.findByText('Use at least 8 characters.')).toBeTruthy();
    expect(screen.getByText(en.validation.confirmRequired)).toBeTruthy();
    await user.clear(screen.getByLabelText(en.fields.newPassword));
    await fill(user, NEW_PASSWORD, 'something else');
    expect(await screen.findByText(en.validation.passwordsDontMatch)).toBeTruthy();
    const confirm = screen.getByLabelText(en.fields.confirmPassword);
    expect(confirm.getAttribute('aria-invalid')).toBe('true');
    expect(http.publicPost).not.toHaveBeenCalled();

    // Fixing the repeat field and pressing the button again sends it.
    http.publicPost.mockResolvedValue({ status: 'password-reset' });
    await user.clear(confirm);
    await user.type(confirm, NEW_PASSWORD);
    await user.click(screen.getByRole('button', { name: en.resetPassword.submit }));
    expect(await screen.findByRole('heading', { name: en.resetPassword.doneTitle })).toBeTruthy();
    expect(http.publicPost).toHaveBeenCalledOnce();
  });

  it('a missing or malformed token → "this link doesn\'t work" with a way to ask again (fa)', async () => {
    for (const hash of ['', '#token=short']) {
      window.history.replaceState(null, '', `/fa/auth/reset-password${hash}`);
      renderWith(<ResetPasswordForm />, 'fa');
      expect(
        await screen.findByRole('heading', { name: fa.resetPassword.invalidTitle }),
      ).toBeTruthy();
      expect(
        screen.getByRole('link', { name: fa.resetPassword.requestNew }).getAttribute('href'),
      ).toBe('/auth/forgot-password');
      cleanup();
    }
    expect(http.publicPost).not.toHaveBeenCalled();
  });

  it('INVALID_TOKEN from the API → the dead-link state; other errors keep the form', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/en/auth/reset-password#token=${TOKEN}`);
    http.publicPost
      .mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 'offline'))
      .mockRejectedValueOnce(new ApiError('INVALID_TOKEN', 'bad', { status: 400 }));
    renderWith(<ResetPasswordForm />);
    await screen.findByRole('button', { name: en.resetPassword.submit });
    await fill(user, NEW_PASSWORD, NEW_PASSWORD);
    expect((await screen.findByRole('alert')).textContent).toBe(
      messages.en.apiErrors.NETWORK_ERROR,
    );
    await user.click(screen.getByRole('button', { name: en.resetPassword.submit }));
    expect(
      await screen.findByRole('heading', { name: en.resetPassword.invalidTitle }),
    ).toBeTruthy();
  });
});

describe('resetFormSchema', () => {
  it('compares the two fields after NFKC normalisation and outputs the normalised password', () => {
    const ok = resetFormSchema.safeParse({
      password: 'ｐａｓｓｗｏｒｄ１２',
      confirm: 'password12',
    });
    expect(ok).toEqual({ success: true, data: { password: 'password12' } });
    const mismatch = resetFormSchema.safeParse({ password: 'password12', confirm: 'password13' });
    expect(mismatch.success).toBe(false);
  });
});
