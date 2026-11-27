'use client';

import { ACCOUNT_DELETION_GRACE_DAYS } from '@habit/shared-types';
import { Alert, Button, Skeleton } from '@habit/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { restoreAccount } from '@/lib/account/privacy';
import { isApiError } from '@/lib/api/errors';
import { signInHref } from '@/lib/auth/redirect';
import { removeHashFromAddressBar, restoreTokenFromHash } from '@/lib/auth/verification';
import { Link } from '@/lib/i18n/navigation';
import { useAuthErrorMessage } from './auth-messages';

type Step =
  | { step: 'reading' }
  | { step: 'ready'; token: string }
  | { step: 'restored' }
  | { step: 'invalid' };

/**
 * The page the "account deleted" email links to (backlog P2-10, ADR-0025), built like the
 * verification page (ADR-0021): the token is read once from the URL fragment, removed from the
 * address bar and kept in memory; nothing happens until the user presses **Restore** (a GET never
 * restores — mail scanners open links). Success → "your account is back" with a sign-in link (no
 * automatic sign-in). Any dead link → one message that also states the grace period. Network and
 * rate-limit errors keep the button for a retry. The result heading receives focus.
 */
export function RestoreAccount() {
  const t = useTranslations('auth.restoreAccount');
  const errorMessage = useAuthErrorMessage();
  const [state, setState] = useState<Step>({ step: 'reading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef<string | null | undefined>(undefined);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (token.current === undefined) {
      token.current = restoreTokenFromHash(window.location.hash);
      removeHashFromAddressBar();
    }
    setState(token.current ? { step: 'ready', token: token.current } : { step: 'invalid' });
  }, []);

  useEffect(() => {
    if (state.step === 'restored' || state.step === 'invalid') resultHeading.current?.focus();
  }, [state.step]);

  async function onConfirm() {
    if (busy || state.step !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await restoreAccount(state.token);
      token.current = null;
      setState({ step: 'restored' });
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
      <div data-restore-step="reading" aria-busy="true" className="flex flex-col gap-4">
        <p role="status" className="sr-only">
          {t('reading')}
        </p>
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }

  if (state.step === 'restored' || state.step === 'invalid') {
    const restored = state.step === 'restored';
    return (
      <div data-restore-step={state.step} className="flex flex-col gap-4">
        <h2
          ref={resultHeading}
          tabIndex={-1}
          className="text-xl font-semibold text-text-primary outline-none"
        >
          {restored ? t('restoredTitle') : t('invalidTitle')}
        </h2>
        <p className="text-text-secondary">
          {restored ? t('restoredBody') : t('invalidBody', { days: ACCOUNT_DELETION_GRACE_DAYS })}
        </p>
        {restored ? (
          <Button asChild size="lg">
            <Link href={signInHref(null)}>{t('signIn')}</Link>
          </Button>
        ) : (
          <Button asChild size="lg" variant="outline">
            <Link href="/">{t('home')}</Link>
          </Button>
        )}
      </div>
    );
  }

  return (
    <div data-restore-step="ready" aria-busy={busy} className="flex flex-col gap-5">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="button" size="lg" aria-disabled={busy} onClick={() => void onConfirm()}>
        {busy ? t('confirming') : t('confirm')}
      </Button>
    </div>
  );
}
