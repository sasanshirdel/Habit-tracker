import type {
  AuthenticatedUser,
  EmailVerifiedResponse,
  LoginResponse,
  RegisterRequest,
  RegistrationAcceptedResponse,
  VerificationEmailAcceptedResponse,
} from '@habit/shared-types';
import type { SignInCredentials } from '@habit/shared-validation';
import type { QueryClient } from '@tanstack/react-query';
import { api, csrfTokens, publicApi } from '@/lib/api/api';
import { sessionQueryKey, type SessionState } from './session';

/**
 * Sign-up, sign-in and sign-out from the browser (backlog P2-09). Credentials go to the API and
 * nowhere else: no web storage, no cookies the page can read, no logging. Errors are the API
 * client's `ApiError`s; the forms map their codes to messages.
 */

/**
 * Removes every cached query except the session itself, which is overwritten in place (removing
 * it would detach the components observing it).
 */
function dropUserData(queryClient: QueryClient): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionQueryKey[0] });
}

function setSession(queryClient: QueryClient, state: SessionState): void {
  queryClient.setQueryData(sessionQueryKey, () => state);
}

/** `POST /auth/register` → 202 whether or not the address was free (no enumeration). */
export async function signUp(input: RegisterRequest): Promise<RegistrationAcceptedResponse> {
  return publicApi.post<RegistrationAcceptedResponse>('/auth/register', input);
}

/**
 * `POST /auth/login`. On success the API has set the session cookie; the response's CSRF token is
 * kept in memory and the cached session becomes "signed in" without another round-trip.
 */
export async function signIn(
  queryClient: QueryClient,
  credentials: SignInCredentials,
): Promise<AuthenticatedUser> {
  const { user, csrfToken } = await publicApi.post<LoginResponse>('/auth/login', credentials);
  csrfTokens.remember(csrfToken);
  // Anything cached belonged to whoever was signed in before (or to nobody).
  dropUserData(queryClient);
  setSession(queryClient, { status: 'signed-in', user });
  return user;
}

/**
 * `POST /auth/logout` (CSRF-protected while the session is live). Only after the API confirmed it
 * is local state dropped — every cached query (other users must never see this user's data) and
 * the CSRF token. If the request fails the user is still signed in and the caller shows the error.
 */
export async function signOut(queryClient: QueryClient): Promise<void> {
  await api.post<void>('/auth/logout');
  csrfTokens.remember(null);
  dropUserData(queryClient);
  setSession(queryClient, { status: 'signed-out', reason: 'signed-out' });
}

/**
 * `POST /auth/verification/confirm` (P2-04, ADR-0021) with the token from the emailed link. Needs
 * no session (CSRF-less client, like sign-in). Afterwards the cached session — if this tab is
 * signed in — is re-checked so "verified" shows everywhere. A bad link is `ApiError`
 * `INVALID_TOKEN`.
 */
export async function confirmEmail(
  queryClient: QueryClient,
  token: string,
): Promise<EmailVerifiedResponse> {
  const result = await publicApi.post<EmailVerifiedResponse>('/auth/verification/confirm', {
    token,
  });
  await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
  return result;
}

/**
 * `POST /auth/verification/resend` (signed in, CSRF-protected): emails a new link, replacing the
 * earlier ones. Too soon/too often → `ApiError` `RATE_LIMITED` with `policy: verification-email`.
 */
export async function resendVerificationEmail(): Promise<VerificationEmailAcceptedResponse> {
  return api.post<VerificationEmailAcceptedResponse>('/auth/verification/resend');
}
