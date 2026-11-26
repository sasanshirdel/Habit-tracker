'use client';

import { Alert, Button, Skeleton } from '@habit/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '@/lib/api/errors';
import { confirmEmail } from '@/lib/auth/actions';
import { signInHref } from '@/lib/auth/redirect';
import { removeHashFromAddressBar, verificationTokenFromHash } from '@/lib/auth/verification';
import { Link } from '@/lib/i18n/navigation';
import { useAuthErrorMessage } from './auth-messages';

type Step =
  | { step: 'reading' }
  | { step: 'ready'; token: string }
  | { step: 'verified' }
  | { step: 'invalid' };

/**
 * The page an emailed verification link opens (backlog P2-04, ADR-0021).
 *
 * 1. Reads the token from the URL fragment once, removes it from the address bar and keeps it in
 *    memory (never storage, never logged). Nothing is sent yet — the server HTML and the first
 *    client render show a neutral "reading" state.
 * 2. The user presses **Confirm** → `POST /auth/verification/confirm`. A GET never verifies, so a
 *    mail scanner or link preview that opens the URL changes nothing.
 * 3. Success → "confirmed" with a Continue link (the sign-in page sends signed-in visitors on to
 *    the app). Any bad link (missing, malformed, expired, used, superseded) → one "this link
 *    doesn't work" message with the way forward. Network/rate-limit errors keep the button for a
 *    retry. The result heading receives focus.
 */
export function VerifyEmail() {
  const t = useTranslations('auth.verifyEmail');
  const errorMessage = useAuthErrorMessage();
  const queryClient = useQueryClient();
  const [state, setState] = useState<Step>({ step: 'reading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once: React's development double-invoked effects must not lose the token after the first
  // run removed it from the address bar.
  const token = useRef<string | null | undefined>(undefined);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (token.current === undefined) {
      token.current = verificationTokenFromHash(window.location.hash);
      removeHashFromAddressBar();
    }
    setState(token.current ? { step: 'ready', token: token.current } : { step: 'invalid' });

    // A second link opened in this same tab only changes the fragment (no page load).
    function onHashChange() {
      const next = verificationTokenFromHash(window.location.hash);
      if (!next) return;
      removeHashFromAddressBar();
      token.current = next;
      setError(null);
      setState({ step: 'ready', token: next });
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (state.step === 'verified' || state.step === 'invalid') resultHeading.current?.focus();
  }, [state.step]);

  async function onConfirm() {
    if (busy || state.step !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await confirmEmail(queryClient, state.token);
      token.current = null;
      setState({ step: 'verified' });
    } catch (caught) {
      if (isApiError(caught) && caught.code === 'INVALID_TOKEN') {
        token.current = null;
        setState({ step: 'invalid' });
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  if (state.step === 'reading') {
    return (
      <div data-verify-step="reading" aria-busy="true" className="flex flex-col gap-4">
        <p role="status" className="sr-only">
          {t('reading')}
        </p>
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }

  if (state.step === 'verified' || state.step === 'invalid') {
    const verified = state.step === 'verified';
    return (
      <div data-verify-step={state.step} className="flex flex-col gap-4">
        <h2
          ref={resultHeading}
          tabIndex={-1}
          className="text-xl font-semibold text-text-primary outline-none"
        >
          {verified ? t('verifiedTitle') : t('invalidTitle')}
        </h2>
        <p className="text-text-secondary">{verified ? t('verifiedBody') : t('invalidBody')}</p>
        <Button asChild size="lg">
          <Link href={signInHref(null)}>{verified ? t('continue') : t('signIn')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div data-verify-step="ready" aria-busy={busy} className="flex flex-col gap-5">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="button" size="lg" aria-disabled={busy} onClick={() => void onConfirm()}>
        {busy ? t('confirming') : t('confirm')}
      </Button>
    </div>
  );
}
