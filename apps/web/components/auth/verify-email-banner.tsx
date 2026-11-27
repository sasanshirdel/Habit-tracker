'use client';

import { Alert, Button } from '@habit/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { resendVerificationEmail } from '@/lib/auth/actions';
import { isolateBidi } from '@/lib/i18n/bidi';
import { useAuthErrorMessage } from './auth-messages';

type Status =
  { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

/**
 * Reminder at the top of every app page while the account's email address is not verified
 * (backlog P2-04, ADR-0021), with "Send a new link" (`POST /auth/verification/resend`; earlier
 * links stop working). Unverified accounts may use the app (interim policy); features that need a
 * verified address are refused by the API (`EMAIL_NOT_VERIFIED`). The result is announced
 * (status/alert); a per-account limit answers with how long to wait.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  const t = useTranslations('auth.verifyBanner');
  const errorMessage = useAuthErrorMessage();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const sending = status.kind === 'sending';

  async function onResend() {
    if (sending) return;
    setStatus({ kind: 'sending' });
    try {
      await resendVerificationEmail();
      setStatus({ kind: 'sent' });
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) });
    }
  }

  return (
    <section
      data-verify-banner=""
      aria-labelledby="verify-email-banner-title"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-border-strong bg-surface p-4 md:flex-row md:items-center md:gap-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Not a heading: it sits above the page's own h1. */}
        <p id="verify-email-banner-title" className="font-semibold text-text-primary">
          {t('title')}
        </p>
        <p className="text-sm break-words text-text-secondary">
          {t('body', { email: isolateBidi(email) })}
        </p>
        {status.kind === 'sent' ? (
          <Alert tone="success" className="mt-2">
            {t('sent')}
          </Alert>
        ) : null}
        {status.kind === 'error' ? (
          <Alert tone="danger" className="mt-2">
            {status.message}
          </Alert>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        className="shrink-0 self-start md:self-center"
        aria-disabled={sending}
        onClick={() => void onResend()}
      >
        {sending ? t('resending') : t('resend')}
      </Button>
    </section>
  );
}
