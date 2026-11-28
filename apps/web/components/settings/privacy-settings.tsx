'use client';

import { ACCOUNT_DELETION_GRACE_DAYS } from '@habit/shared-types';
import { deletionConfirmationMatches } from '@habit/shared-validation';
import {
  Alert,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  PasswordInput,
  toast,
} from '@habit/ui';
import { DownloadIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';
import { useAuthErrorMessage } from '@/components/auth/auth-messages';
import { useDeleteAccount, useExportData } from '@/lib/account/privacy';
import { isApiError } from '@/lib/api/errors';
import { serverFieldErrors } from '@/lib/forms/server-errors';
import { useSession } from '@/lib/auth/session';

/** First-strong isolate: keeps an email address in one piece inside Persian text. */
const isolate = (text: string) => `\u2068${text}\u2069`;

/**
 * Settings → Your data (backlog P2-10, ADR-0025): download a copy of everything stored about the
 * user, and delete the account. Rendered only inside `AuthGate` (in the browser, signed in); the
 * server HTML is a static frame. Deletion needs the current password (checked by the API) and the
 * account's email address typed out (a deliberate step, checked here only), in a dialog that
 * states the grace period.
 */
export function PrivacySettings() {
  return (
    <div className="flex flex-col gap-10">
      <ExportSection />
      <DeleteSection />
    </div>
  );
}

function ExportSection() {
  const t = useTranslations('settings.privacy.export');
  const exportData = useExportData();

  async function onExport() {
    try {
      await exportData.mutateAsync();
      toast({ title: t('done'), variant: 'success' });
    } catch {
      toast({ title: t('failed'), variant: 'error' });
    }
  }

  return (
    <section
      aria-labelledby="export-title"
      aria-busy={exportData.isPending}
      className="flex flex-col gap-4"
      data-export-data=""
    >
      <div className="flex flex-col gap-1">
        <h2 id="export-title" className="text-lg font-semibold text-text-primary">
          {t('title')}
        </h2>
        <p className="text-sm text-text-secondary">{t('description')}</p>
      </div>
      <Alert tone="info">{t('warning')}</Alert>
      <Button
        className="self-start"
        aria-disabled={exportData.isPending}
        onClick={() => {
          if (!exportData.isPending) void onExport();
        }}
      >
        <DownloadIcon aria-hidden="true" />
        {exportData.isPending ? t('preparing') : t('download')}
      </Button>
      <p role="status" className="sr-only">
        {exportData.isPending ? t('preparing') : ''}
      </p>
    </section>
  );
}

function DeleteSection() {
  const t = useTranslations('settings.privacy.delete');
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-labelledby="delete-title"
      className="flex flex-col gap-4 rounded-lg border border-danger/40 p-4"
      data-delete-account=""
    >
      <div className="flex flex-col gap-1">
        <h2
          id="delete-title"
          className="flex items-center gap-2 text-lg font-semibold text-text-primary"
        >
          <TriangleAlertIcon aria-hidden="true" className="size-5 text-danger" />
          {t('title')}
        </h2>
        <p className="text-sm text-text-secondary">{t('description')}</p>
        <p className="text-sm text-text-secondary">
          {t('grace', { days: ACCOUNT_DELETION_GRACE_DAYS })}
        </p>
        <p className="text-sm text-text-secondary">{t('exportFirst')}</p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* DialogTrigger (not a plain onClick) so Radix returns focus here when the dialog closes. */}
        <DialogTrigger asChild>
          <Button variant="danger" className="self-start">
            {t('open')}
          </Button>
        </DialogTrigger>
        <DialogContent closeLabel={t('cancel')}>{open ? <DeleteForm /> : null}</DialogContent>
      </Dialog>
    </section>
  );
}

function DeleteForm() {
  const t = useTranslations('settings.privacy.delete');
  const tFields = useTranslations('auth.fields');
  const errorMessage = useAuthErrorMessage();
  const session = useSession();
  const remove = useDeleteAccount();
  const id = useId();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** The API's validation issue code for the password, until it is edited (ADR-0027). */
  const [serverPasswordIssue, setServerPasswordIssue] = useState<string | null>(null);
  const email = session.data?.status === 'signed-in' ? session.data.user.email : '';

  const passwordMissing = password.length === 0;
  const confirmationWrong = !deletionConfirmationMatches(confirmation, email);
  const ids = {
    password: `${id}-password`,
    passwordHint: `${id}-password-hint`,
    passwordError: `${id}-password-error`,
    confirm: `${id}-confirm`,
    confirmHint: `${id}-confirm-hint`,
    confirmError: `${id}-confirm-error`,
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setFormError(null);
    setServerPasswordIssue(null);
    if (passwordMissing || confirmationWrong || remove.isPending) {
      const first = passwordMissing ? ids.password : ids.confirm;
      if (passwordMissing || confirmationWrong) window.document.getElementById(first)?.focus();
      return;
    }
    try {
      await remove.mutateAsync(password);
      // AuthGate moves on to the confirmation page (the session is now "account deleted").
    } catch (error) {
      const [issue] = serverFieldErrors(error, ['password']);
      if (issue) {
        // Refused by the API's schema: shown on the password field, which gets focus.
        setServerPasswordIssue(issue.code);
        window.document.getElementById(ids.password)?.focus();
        return;
      }
      if (isApiError(error) && error.code === 'REAUTHENTICATION_FAILED') {
        setPassword('');
        window.document.getElementById(ids.password)?.focus();
      }
      setFormError(errorMessage(error));
    }
  }

  const passwordError =
    submitted && passwordMissing
      ? t('passwordRequired')
      : serverPasswordIssue
        ? serverPasswordIssue === 'too_small'
          ? t('passwordRequired')
          : t('passwordRejected')
        : null;
  const showPasswordError = passwordError !== null;
  const showConfirmError = submitted && confirmationWrong;

  return (
    <form noValidate onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t('dialogTitle')}</DialogTitle>
        <DialogDescription>
          {t('dialogDescription', { days: ACCOUNT_DELETION_GRACE_DAYS })}
        </DialogDescription>
      </DialogHeader>
      {formError ? (
        <Alert tone="danger" data-delete-error="">
          {formError}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor={ids.password}>{t('password')}</Label>
        <PasswordInput
          id={ids.password}
          name="password"
          autoComplete="current-password"
          toggleLabel={tFields('showPassword')}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setServerPasswordIssue(null);
          }}
          aria-invalid={showPasswordError || undefined}
          aria-describedby={`${ids.passwordHint}${showPasswordError ? ` ${ids.passwordError}` : ''}`}
        />
        <p id={ids.passwordHint} className="text-sm text-text-secondary">
          {t('passwordHint')}
        </p>
        {showPasswordError ? (
          <p id={ids.passwordError} data-slot="field-error" className="text-sm text-danger">
            {passwordError}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={ids.confirm}>{t('confirmLabel')}</Label>
        <Input
          id={ids.confirm}
          name="confirm-email"
          type="email"
          dir="ltr"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="text-start"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          aria-invalid={showConfirmError || undefined}
          aria-describedby={`${ids.confirmHint}${showConfirmError ? ` ${ids.confirmError}` : ''}`}
        />
        <p id={ids.confirmHint} className="text-sm text-text-secondary">
          {t('confirmHint', { email: isolate(email) })}
        </p>
        {showConfirmError ? (
          <p id={ids.confirmError} className="text-sm text-danger">
            {t('confirmMismatch')}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t('cancel')}
          </Button>
        </DialogClose>
        <Button type="submit" variant="danger" aria-disabled={remove.isPending}>
          {remove.isPending ? t('deleting') : t('confirm')}
        </Button>
      </DialogFooter>
    </form>
  );
}
