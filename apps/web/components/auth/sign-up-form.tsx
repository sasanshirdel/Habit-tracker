'use client';

import {
  PASSWORD_MIN_LENGTH,
  signUpCredentialsSchema,
  type SignUpCredentials,
} from '@habit/shared-validation';
import { Alert, Button } from '@habit/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { signUp } from '@/lib/auth/actions';
import { signInHref } from '@/lib/auth/redirect';
import { browserTimeZone } from '@/lib/auth/time-zone';
import { schemaResolver } from '@/lib/forms/schema-resolver';
import type { Locale } from '@/lib/i18n/config';
import { Link } from '@/lib/i18n/navigation';
import { useAuthErrorMessage, useFieldErrorMessage } from './auth-messages';
import { EmailField, PasswordField } from './credential-fields';

type SignUpFields = { email: string; password: string };

/**
 * Sign-up form (backlog P2-09). Posts to `POST /auth/register` with the page's locale (stored as
 * the language preference) and the browser's time zone. The API answers 202 whether or not the
 * address was free, so the confirmation is worded for both cases and does not sign in (ADR-0018).
 * Until email verification exists (P2-04) the next step is "sign in"; P2-04 changes this copy to
 * "check your email".
 */
export function SignUpForm({ next }: { next: string | null }) {
  const t = useTranslations('auth');
  const locale = useLocale() as Locale;
  const authError = useAuthErrorMessage();
  const fieldError = useFieldErrorMessage();
  const [formError, setFormError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const acceptedHeading = useRef<HTMLHeadingElement>(null);
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<SignUpFields, unknown, SignUpCredentials>({
    resolver: schemaResolver<SignUpFields, SignUpCredentials>(signUpCredentialsSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onSubmit',
    reValidateMode: 'onBlur',
  });

  useEffect(() => {
    if (accepted) acceptedHeading.current?.focus();
  }, [accepted]);

  const onSubmit = handleSubmit(async (credentials) => {
    setFormError(null);
    try {
      await signUp({ ...credentials, locale, timezone: browserTimeZone() });
      setAccepted(true);
    } catch (error) {
      setFormError(authError(error));
    }
  });

  if (accepted) {
    return (
      <div data-auth-step="accepted" className="flex flex-col gap-4">
        <h2
          ref={acceptedHeading}
          tabIndex={-1}
          className="text-xl font-semibold text-text-primary outline-none"
        >
          {t('signUp.acceptedTitle')}
        </h2>
        <p className="text-text-secondary">{t('signUp.acceptedBody')}</p>
        <Button asChild size="lg">
          <Link href={signInHref(next)}>{t('signUp.acceptedAction')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form
      noValidate
      // One request at a time: a second Enter/click while submitting does nothing.
      onSubmit={(event) => (isSubmitting ? event.preventDefault() : void onSubmit(event))}
      aria-busy={isSubmitting}
      className="flex flex-col gap-5"
    >
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <EmailField
        autoComplete="email"
        registration={register('email')}
        error={fieldError('email', errors.email, getValues('email'))}
      />
      <PasswordField
        autoComplete="new-password"
        registration={register('password')}
        hint={t('signUp.passwordHint', { min: PASSWORD_MIN_LENGTH })}
        error={fieldError('password', errors.password, getValues('password'))}
      />
      <Button type="submit" size="lg" aria-disabled={isSubmitting}>
        {isSubmitting ? t('signUp.submitting') : t('signUp.submit')}
      </Button>
      <p className="text-sm text-text-secondary">
        {t('signUp.haveAccount')}{' '}
        <Link
          href={signInHref(next)}
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          {t('signUp.signIn')}
        </Link>
      </p>
    </form>
  );
}
