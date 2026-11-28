'use client';

import {
  PASSWORD_MIN_LENGTH,
  normalizePassword,
  passwordResetSchema,
  type PasswordResetInput,
} from '@habit/shared-validation';
import { Alert, Button, Skeleton } from '@habit/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { isApiError } from '@/lib/api/errors';
import { resetPassword } from '@/lib/auth/actions';
import { forgotPasswordHref, signInHref } from '@/lib/auth/redirect';
import { removeHashFromAddressBar, resetTokenFromHash } from '@/lib/auth/verification';
import {
  schemaResolver,
  type SafeParseSchema,
  type SchemaIssue,
} from '@/lib/forms/schema-resolver';
import { applyServerFieldErrors, validationIssuesOf } from '@/lib/forms/server-errors';
import { Link } from '@/lib/i18n/navigation';
import { useAuthErrorMessage, useFieldErrorMessage } from './auth-messages';
import { PasswordField } from './credential-fields';

type ResetFields = { password: string; confirm: string };

/**
 * The shared new-password policy plus "both fields match" (checked in the browser only; the API
 * receives one password). Compared after NFKC normalisation, like the API compares passwords.
 */
export const resetFormSchema: SafeParseSchema<PasswordResetInput> = {
  safeParse(input) {
    const values = (input ?? {}) as Partial<ResetFields>;
    const password = typeof values.password === 'string' ? values.password : '';
    const confirm = typeof values.confirm === 'string' ? values.confirm : '';
    const result = passwordResetSchema.safeParse({ password });
    const issues: SchemaIssue[] = result.success ? [] : [...result.error.issues];
    if (confirm === '') {
      issues.push({ code: 'confirm_required', path: ['confirm'], message: 'confirm_required' });
    } else if (normalizePassword(confirm) !== normalizePassword(password)) {
      issues.push({ code: 'mismatch', path: ['confirm'], message: 'mismatch' });
    }
    if (issues.length > 0) return { success: false, error: { issues } };
    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: { issues } };
  },
};

type Step =
  { step: 'reading' } | { step: 'ready'; token: string } | { step: 'done' } | { step: 'invalid' };

/**
 * The page a password-reset link opens (backlog P2-05, ADR-0022).
 *
 * 1. Reads the token from the URL fragment once, removes it from the address bar and keeps it in
 *    memory (never storage, never logged). The server HTML and first render show "reading".
 * 2. The user types the new password twice and presses **Change password** →
 *    `POST /auth/password-reset/confirm`. Opening the link alone changes nothing (mail scanners).
 * 3. Success → "Password changed" with a Sign in button: the API ended every session and does not
 *    sign in. A dead link (missing, malformed, expired, used, superseded) → "This link doesn't
 *    work" with a way to ask for a new one. Other errors (network, rate limit, a password the
 *    server refuses) keep the form for another try. Result headings receive focus.
 */
export function ResetPasswordForm() {
  const t = useTranslations('auth');
  const authError = useAuthErrorMessage();
  const fieldError = useFieldErrorMessage();
  const queryClient = useQueryClient();
  const [state, setState] = useState<Step>({ step: 'reading' });
  const [formError, setFormError] = useState<string | null>(null);
  // Read once (React's development double-invoked effects must not lose it).
  const token = useRef<string | null | undefined>(undefined);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const {
    register,
    handleSubmit,
    getValues,
    setFocus,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetFields, unknown, PasswordResetInput>({
    resolver: schemaResolver<ResetFields, PasswordResetInput>(resetFormSchema),
    defaultValues: { password: '', confirm: '' },
    mode: 'onSubmit',
    // After a failed submit, re-check while typing (not on blur): clearing the "don't match"
    // message on blur would move the button away between mouse-down and mouse-up, eating the click.
    reValidateMode: 'onChange',
  });

  useEffect(() => {
    if (token.current === undefined) {
      token.current = resetTokenFromHash(window.location.hash);
      removeHashFromAddressBar();
    }
    setState(token.current ? { step: 'ready', token: token.current } : { step: 'invalid' });

    // A second link opened in this same tab only changes the fragment (no page load).
    function onHashChange() {
      const next = resetTokenFromHash(window.location.hash);
      if (!next) return;
      removeHashFromAddressBar();
      token.current = next;
      setFormError(null);
      setState({ step: 'ready', token: next });
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (state.step === 'done' || state.step === 'invalid') {
      token.current = null; // a used or dead link is not kept, even in memory
      resultHeading.current?.focus();
    }
  }, [state.step]);

  // The token travels in state (not read from the ref here): the result states drop it.
  const current = state.step === 'ready' ? state.token : null;
  const onSubmit = handleSubmit(async ({ password }) => {
    if (!current) return;
    setFormError(null);
    try {
      await resetPassword(queryClient, current, password);
      setState({ step: 'done' });
    } catch (error) {
      // A token the API cannot even parse (`VALIDATION_FAILED` on `body.token`) is a dead link
      // like any other.
      const deadLink =
        (isApiError(error) && error.code === 'INVALID_TOKEN') ||
        validationIssuesOf(error).some((issue) => issue.field === 'body.token');
      if (deadLink) {
        setState({ step: 'invalid' });
        return;
      }
      // The new password broke the server's policy: shown on the field; the link stays usable.
      if (applyServerFieldErrors(error, { setError, setFocus }, ['password'])) return;
      setFormError(authError(error));
      setFocus('password');
    }
  });

  if (state.step === 'reading') {
    return (
      <div data-reset-step="reading" aria-busy="true" className="flex flex-col gap-4">
        <p role="status" className="sr-only">
          {t('resetPassword.reading')}
        </p>
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }

  if (state.step === 'done' || state.step === 'invalid') {
    const done = state.step === 'done';
    return (
      <div data-reset-step={state.step} className="flex flex-col gap-4">
        <h2
          ref={resultHeading}
          tabIndex={-1}
          className="text-xl font-semibold text-text-primary outline-none"
        >
          {done ? t('resetPassword.doneTitle') : t('resetPassword.invalidTitle')}
        </h2>
        <p className="text-text-secondary">
          {done ? t('resetPassword.doneBody') : t('resetPassword.invalidBody')}
        </p>
        <Button asChild size="lg">
          <Link href={done ? signInHref(null) : forgotPasswordHref}>
            {done ? t('resetPassword.signIn') : t('resetPassword.requestNew')}
          </Link>
        </Button>
      </div>
    );
  }

  const confirmError = errors.confirm
    ? errors.confirm.type === 'mismatch'
      ? t('validation.passwordsDontMatch')
      : t('validation.confirmRequired')
    : undefined;

  return (
    <form
      noValidate
      data-reset-step="ready"
      // One request at a time: a second Enter/click while submitting does nothing.
      onSubmit={(event) => (isSubmitting ? event.preventDefault() : void onSubmit(event))}
      aria-busy={isSubmitting}
      className="flex flex-col gap-5"
    >
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <PasswordField
        autoComplete="new-password"
        label={t('fields.newPassword')}
        registration={register('password')}
        hint={t('signUp.passwordHint', { min: PASSWORD_MIN_LENGTH })}
        error={fieldError('password', errors.password, getValues('password'))}
      />
      <PasswordField
        autoComplete="new-password"
        label={t('fields.confirmPassword')}
        registration={register('confirm')}
        error={confirmError}
      />
      <Button type="submit" size="lg" aria-disabled={isSubmitting}>
        {isSubmitting ? t('resetPassword.submitting') : t('resetPassword.submit')}
      </Button>
    </form>
  );
}
