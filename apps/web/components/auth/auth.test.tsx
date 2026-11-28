// @vitest-environment jsdom
import { Toaster, UiProvider } from '@habit/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import type { Locale } from '@/lib/i18n/config';
import { formats } from '@/lib/i18n/formats';
import { messages } from '@/lib/i18n/messages';
import { AccountMenu } from './account-menu';
import { AuthGate } from './auth-gate';
import { SignInForm } from './sign-in-form';
import { SignUpForm } from './sign-up-form';

const nav = vi.hoisted(() => ({ pathname: '/habits', replace: vi.fn() }));
vi.mock('@/lib/i18n/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
  Link: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props} />
  ),
}));

const http = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  publicPost: vi.fn(),
  remember: vi.fn(),
}));
vi.mock('@/lib/api/api', () => ({
  api: { get: http.get, post: http.post },
  publicApi: { post: http.publicPost },
  csrfTokens: { remember: http.remember, get: vi.fn(), forget: vi.fn() },
}));

const USER = {
  id: '0190f3c4-0000-7000-8000-000000000001',
  email: 'sara@example.com',
  emailVerified: false,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  nav.pathname = '/habits';
  nav.replace.mockReset();
  http.get
    .mockReset()
    .mockRejectedValue(new ApiError('UNAUTHENTICATED', 'no session', { status: 401 }));
  http.post.mockReset();
  http.publicPost.mockReset();
  http.remember.mockReset();
});

afterEach(cleanup);

function renderWith(ui: ReactNode, locale: Locale = 'en', session?: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (session) queryClient.setQueryData(['auth', 'session'], session);
  const view = render(
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
  return { ...view, queryClient };
}

const en = messages.en.auth;
const fa = messages.fa.auth;

describe('SignInForm (P2-09)', () => {
  it('labels its fields, sets the autocomplete attributes and keeps them left-to-right', () => {
    renderWith(<SignInForm next={null} />, 'fa');
    const email = screen.getByLabelText(fa.fields.email);
    const password = screen.getByLabelText(fa.fields.password);
    expect(email.getAttribute('type')).toBe('email');
    expect(email.getAttribute('autocomplete')).toBe('username');
    expect(email.getAttribute('dir')).toBe('ltr');
    expect(password.getAttribute('type')).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expect(screen.getByRole('button', { name: fa.fields.showPassword })).toBeTruthy();
    expect(screen.getByRole('button', { name: fa.signIn.submit })).toBeTruthy();
  });

  it('validates before calling the API: required fields, linked errors, focus on the first', async () => {
    const user = userEvent.setup();
    renderWith(<SignInForm next={null} />);
    await user.click(screen.getByRole('button', { name: en.signIn.submit }));
    const email = screen.getByLabelText(en.fields.email);
    expect(await screen.findByText(en.validation.emailRequired)).toBeTruthy();
    expect(screen.getByText(en.validation.passwordRequired)).toBeTruthy();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    const describedBy = email.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(en.validation.emailRequired);
    expect(document.activeElement).toBe(email);
    expect(http.publicPost).not.toHaveBeenCalled();

    await user.type(email, 'not-an-email');
    await user.click(screen.getByRole('button', { name: en.signIn.submit }));
    expect(await screen.findByText(en.validation.emailInvalid)).toBeTruthy();
  });

  it('signs in with the normalised credentials, keeps the CSRF token in memory, goes to next', async () => {
    const user = userEvent.setup();
    http.publicPost.mockResolvedValue({ user: USER, csrfToken: 'csrf-1' });
    renderWith(<SignInForm next="/habits" />);
    await user.type(screen.getByLabelText(en.fields.email), '  Sara@Example.com ');
    await user.type(screen.getByLabelText(en.fields.password), 'correct horse');
    await user.click(screen.getByRole('button', { name: en.signIn.submit }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/habits'));
    expect(http.publicPost).toHaveBeenCalledWith('/auth/login', {
      email: 'sara@example.com',
      password: 'correct horse',
    });
    expect(http.remember).toHaveBeenCalledWith('csrf-1');
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('shows one generic message for wrong credentials, clears and focuses the password', async () => {
    const user = userEvent.setup();
    http.publicPost.mockRejectedValue(
      new ApiError('INVALID_CREDENTIALS', 'Invalid email or password.', { status: 401 }),
    );
    renderWith(<SignInForm next={null} />);
    const password = screen.getByLabelText(en.fields.password) as HTMLInputElement;
    await user.type(screen.getByLabelText(en.fields.email), 'sara@example.com');
    await user.type(password, 'wrong password');
    await user.click(screen.getByRole('button', { name: en.signIn.submit }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.errors.invalidCredentials);
    expect(password.value).toBe('');
    expect(document.activeElement).toBe(password);
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it.each([
    [{ policy: 'login-account', retryAfterSeconds: 120 }, 'Wait 2 minutes', 'unsuccessful sign-in'],
    [{ policy: 'auth', retryAfterSeconds: 30 }, 'Wait 1 minute', 'from this device'],
  ])('explains rate limits and lockouts (%j)', async (details, wait, kind) => {
    const user = userEvent.setup();
    http.publicPost.mockRejectedValue(
      new ApiError('RATE_LIMITED', 'Too many', {
        status: 429,
        details,
        retryAfterSeconds: details.retryAfterSeconds,
      }),
    );
    renderWith(<SignInForm next={null} />);
    await user.type(screen.getByLabelText(en.fields.email), 'sara@example.com');
    await user.type(screen.getByLabelText(en.fields.password), 'whatever');
    await user.click(screen.getByRole('button', { name: en.signIn.submit }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(kind);
    expect(alert.textContent?.toLowerCase()).toContain(wait.toLowerCase());
  });

  it('sends a visitor who is already signed in on to the (sanitised) next page', async () => {
    http.get.mockResolvedValue({ user: USER, csrfToken: 'csrf-2' });
    renderWith(<SignInForm next={null} />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/overview'));
    expect(http.remember).toHaveBeenCalledWith('csrf-2');
  });
});

describe('SignUpForm (P2-09)', () => {
  it('uses new-password, explains the rule and enforces the shared minimum', async () => {
    const user = userEvent.setup();
    renderWith(<SignUpForm next={null} />);
    const password = screen.getByLabelText(en.fields.password);
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByLabelText(en.fields.email).getAttribute('autocomplete')).toBe('email');
    const hint = en.signUp.passwordHint.replace('{min, number}', '8');
    expect(
      password
        .getAttribute('aria-describedby')
        ?.split(' ')
        .map((id) => document.getElementById(id)?.textContent),
    ).toContain(hint);
    await user.type(screen.getByLabelText(en.fields.email), 'new@example.com');
    await user.type(password, 'short');
    await user.click(screen.getByRole('button', { name: en.signUp.submit }));
    expect(
      await screen.findByText(en.validation.passwordTooShort.replace('{min, number}', '8')),
    ).toBeTruthy();
    expect(http.publicPost).not.toHaveBeenCalled();
  });

  it('registers with the page locale and a valid time zone, then shows the neutral confirmation', async () => {
    const user = userEvent.setup();
    http.publicPost.mockResolvedValue({ status: 'accepted' });
    renderWith(<SignUpForm next="/goals" />, 'fa');
    // Numbers in Persian copy use Persian digits (the password rule: ۸ characters).
    expect(screen.getByText(fa.signUp.passwordHint.replace('{min, number}', '۸'))).toBeTruthy();
    await user.type(screen.getByLabelText(fa.fields.email), 'New@Example.com');
    await user.type(screen.getByLabelText(fa.fields.password), 'a long pass phrase');
    await user.click(screen.getByRole('button', { name: fa.signUp.submit }));
    const heading = await screen.findByRole('heading', { name: fa.signUp.acceptedTitle });
    expect(document.activeElement).toBe(heading);
    const [path, body] = http.publicPost.mock.calls[0]!;
    expect(path).toBe('/auth/register');
    expect(body).toMatchObject({
      email: 'new@example.com',
      password: 'a long pass phrase',
      locale: 'fa',
    });
    expect(typeof body.timezone).toBe('string');
    expect(screen.getByRole('link', { name: fa.signUp.acceptedAction }).getAttribute('href')).toBe(
      '/auth/sign-in?next=%2Fgoals',
    );
  });
});

describe('AuthGate (P2-09)', () => {
  it('shows only a placeholder while checking — never the page', () => {
    http.get.mockReturnValue(new Promise(() => {}));
    const { container } = renderWith(<AuthGate>secret page</AuthGate>);
    expect(container.textContent).not.toContain('secret page');
    expect(container.querySelector('[data-auth-gate="checking"]')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(en.session.checking);
  });

  it('sends a signed-out visitor to sign-in with this page as next', async () => {
    nav.pathname = '/habits/42';
    window.history.replaceState(null, '', '/en/habits/42?tab=history');
    const { container } = renderWith(<AuthGate>secret page</AuthGate>);
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith('/auth/sign-in?next=%2Fhabits%2F42%3Ftab%3Dhistory'),
    );
    expect(container.textContent).not.toContain('secret page');
    window.history.replaceState(null, '', '/');
  });

  it('renders the page once signed in', async () => {
    http.get.mockResolvedValue({ user: USER, csrfToken: 'c' });
    renderWith(<AuthGate>secret page</AuthGate>);
    expect(await screen.findByText('secret page')).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('shows an error with retry (no redirect) when the check itself fails', async () => {
    const user = userEvent.setup();
    http.get.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 'offline'));
    renderWith(<AuthGate>secret page</AuthGate>);
    expect(await screen.findByText(en.session.checkFailed)).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
    http.get.mockResolvedValueOnce({ user: USER, csrfToken: 'c' });
    await user.click(screen.getByRole('button', { name: messages.en.apiErrors.retry }));
    expect(await screen.findByText('secret page')).toBeTruthy();
  });
});

describe('AccountMenu (P2-09)', () => {
  it('signs out through the API, drops cached data, then the gate goes to sign-in without next', async () => {
    const user = userEvent.setup();
    http.get.mockResolvedValue({ user: USER, csrfToken: 'c' });
    http.post.mockResolvedValue(undefined);
    const { queryClient } = renderWith(
      <>
        <AccountMenu />
        <AuthGate>secret page</AuthGate>
      </>,
    );
    await screen.findByText('secret page');
    queryClient.setQueryData(['habits'], ['private']);
    await user.click(screen.getByRole('button', { name: en.session.account }));
    expect(await screen.findByText(`Signed in as \u2068${USER.email}\u2069`)).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: en.session.signOut }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/auth/sign-in'));
    expect(http.post).toHaveBeenCalledWith('/auth/logout');
    expect(http.remember).toHaveBeenLastCalledWith(null);
    expect(queryClient.getQueryData(['habits'])).toBeUndefined();
    expect(screen.queryByText('secret page')).toBeNull();
    expect(await screen.findByText(en.session.signedOut)).toBeTruthy();
  });

  it('stays signed in and says so when sign-out fails', async () => {
    const user = userEvent.setup();
    http.get.mockResolvedValue({ user: USER, csrfToken: 'c' });
    http.post.mockRejectedValue(new ApiError('NETWORK_ERROR', 'offline'));
    renderWith(
      <>
        <AccountMenu />
        <AuthGate>secret page</AuthGate>
      </>,
    );
    await screen.findByText('secret page');
    await user.click(screen.getByRole('button', { name: en.session.account }));
    await user.click(await screen.findByRole('menuitem', { name: en.session.signOut }));
    expect(await screen.findByText(en.session.signOutFailed)).toBeTruthy();
    expect(screen.getByText('secret page')).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
    await act(async () => {});
  });
});

describe('server validation errors on the field (P2-09, ADR-0027)', () => {
  const refused = (issues: { field: string; code: string }[]) =>
    new ApiError('VALIDATION_FAILED', 'Request validation failed.', {
      status: 400,
      details: { issues: issues.map((issue) => ({ ...issue, message: 'English' })) },
    });

  it('sign-in: marks and focuses the refused field, keeps the password, shows no alert', async () => {
    const user = userEvent.setup();
    http.publicPost.mockRejectedValue(refused([{ field: 'body.email', code: 'invalid_format' }]));
    renderWith(<SignInForm next={null} />);
    const email = screen.getByLabelText(en.fields.email);
    const password = screen.getByLabelText(en.fields.password) as HTMLInputElement;
    await user.type(email, 'sara@example.com');
    await user.type(password, 'a pass phrase');
    await user.click(screen.getByRole('button', { name: en.signIn.submit }));
    await waitFor(() => expect(email.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById(email.getAttribute('aria-describedby')!)?.textContent).toBe(
      en.validation.emailInvalid,
    );
    expect(document.activeElement).toBe(email);
    expect(password.value).toBe('a pass phrase');
    expect(screen.queryByRole('alert')).toBeNull();

    // Editing re-checks with the shared schema: the server's mark goes once the value is valid.
    await user.type(email, 'x');
    await waitFor(() => expect(email.getAttribute('aria-invalid')).toBeNull());
  });

  it('sign-up (fa): the first refused field in form order gets focus and Persian text', async () => {
    const user = userEvent.setup();
    http.publicPost.mockRejectedValue(
      refused([
        { field: 'body.password', code: 'too_big' },
        { field: 'body.email', code: 'invalid_format' },
      ]),
    );
    renderWith(<SignUpForm next={null} />, 'fa');
    const email = screen.getByLabelText(fa.fields.email);
    const password = screen.getByLabelText(fa.fields.password);
    await user.type(email, 'new@example.com');
    await user.type(password, 'a long pass phrase');
    await user.click(screen.getByRole('button', { name: fa.signUp.submit }));
    await waitFor(() => expect(document.activeElement).toBe(email));
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(
      screen.getByText(fa.validation.passwordTooLong.replace('{max, number}', '۱۲۸')),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: fa.signUp.acceptedTitle })).toBeNull();
  });

  it('sign-up: an issue outside the visible fields (time zone) is a form-level message', async () => {
    const user = userEvent.setup();
    http.publicPost.mockRejectedValue(refused([{ field: 'body.timezone', code: 'custom' }]));
    renderWith(<SignUpForm next={null} />);
    await user.type(screen.getByLabelText(en.fields.email), 'new@example.com');
    await user.type(screen.getByLabelText(en.fields.password), 'a long pass phrase');
    await user.click(screen.getByRole('button', { name: en.signUp.submit }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.errors.invalidInput);
    expect(screen.getByLabelText(en.fields.email).getAttribute('aria-invalid')).toBeNull();
  });
});

describe('session ended under an open page (P2-09, ADR-0027)', () => {
  it('the gate hides the page and returns to sign-in with this page as next', async () => {
    nav.pathname = '/settings/profile';
    const { queryClient, container } = renderWith(<AuthGate>secret page</AuthGate>);
    act(() => {
      queryClient.setQueryData(['auth', 'session'], { status: 'signed-out', reason: 'expired' });
    });
    await waitFor(() =>
      expect(nav.replace).toHaveBeenCalledWith('/auth/sign-in?next=%2Fsettings%2Fprofile'),
    );
    expect(container.textContent).not.toContain('secret page');
  });

  it('the sign-in form says the session ended (status, not an error)', async () => {
    renderWith(<SignInForm next="/settings/profile" />, 'en', {
      status: 'signed-out',
      reason: 'expired',
    });
    const note = await screen.findByText(en.session.expired);
    expect(note.closest('[role]')?.getAttribute('role')).toBe('status');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
