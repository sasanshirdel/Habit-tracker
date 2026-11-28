'use client';

import { Input, Label, PasswordInput } from '@habit/ui';
import { useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

interface FieldProps {
  registration: UseFormRegisterReturn;
  error?: string;
  /** Persistent help text (e.g. the password rule), announced with the field. */
  hint?: ReactNode;
}

function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const list = ids.filter(Boolean).join(' ');
  return list || undefined;
}

function FieldErrorText({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} data-slot="field-error" className="text-sm text-danger">
      {message}
    </p>
  );
}

/**
 * The email field of the auth forms (P2-09): `type="email"` (email keyboard on phones),
 * `autocomplete` from the caller (`username` on sign-in so password managers pair it with the
 * password, `email` on sign-up), left-to-right even in Persian, no auto-capitalisation or
 * correction. Errors are linked with `aria-describedby` and flagged with `aria-invalid`.
 */
export function EmailField({
  registration,
  error,
  autoComplete,
}: FieldProps & { autoComplete: 'username' | 'email' }) {
  const t = useTranslations('auth.fields');
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{t('email')}</Label>
      <Input
        id={id}
        type="email"
        inputMode="email"
        dir="ltr"
        className="text-start"
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={254}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(error && errorId)}
        {...registration}
      />
      <FieldErrorText id={errorId} message={error} />
    </div>
  );
}

/**
 * The password field of the auth forms (P2-09), with a show/hide toggle. `label` overrides
 * "Password" (the reset page's "New password" / "Repeat new password", P2-05).
 */
export function PasswordField({
  registration,
  error,
  hint,
  autoComplete,
  label,
}: FieldProps & { autoComplete: 'current-password' | 'new-password'; label?: string }) {
  const t = useTranslations('auth.fields');
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label ?? t('password')}</Label>
      <PasswordInput
        id={id}
        autoComplete={autoComplete}
        toggleLabel={t('showPassword')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint !== undefined && hintId, error && errorId)}
        {...registration}
      />
      {hint !== undefined ? (
        <p id={hintId} className="text-sm text-text-secondary">
          {hint}
        </p>
      ) : null}
      <FieldErrorText id={errorId} message={error} />
    </div>
  );
}
