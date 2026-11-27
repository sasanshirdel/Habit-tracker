'use client';

import {
  PASSWORD_RESET_LINK_MINUTES,
  passwordResetRequestSchema,
  type PasswordResetRequestInput,
} from '@habit/shared-validation';
import { Alert, Button } from '@habit/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { requestPasswordReset } from '@/lib/auth/actions';
import { signInHref } from '@/lib/auth/redirect';
import { schemaResolver } from '@/lib/forms/schema-resolver';
import { isolateBidi } from '@/lib/i18n/bidi';
import { Link } from '@/lib/i18n/navigation';
import { useAuthErrorMessage, useFieldErrorMessage } from './auth-messages';
import { EmailField } from './credential-fields';

type ForgotFields = { email: string };

/**
 * "Forgot your password?" (backlog P2-05, ADR-0022). Posts the address to
 * `POST /auth/password-reset/request`, which answers the same 202 for every address — so the
 * confirmation is worded for both cases ("if … belongs to an account") and never says whether an
 * account exists. The result heading receives focus. Rate limits (`auth` class per device) get the
 * usual "wait N minutes" message; the per-address limit is invisible by design.
 */
export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const authError = useAuthErrorMessage();
  const fieldError = useFieldErrorMessage();
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const sentHeading = useRef<HTMLHeadingElement>(null);
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ForgotFields, unknown, PasswordResetRequestInput>({
    resolver: schemaResolver<ForgotFields, PasswordResetRequestInput>(passwordResetRequestSchema),
    defaultValues: { email: '' },
    mode: 'onSubmit',
    // After a failed submit, re-check while typing, not on blur: a message vanishing on blur moves
    // the submit button between mouse-down and mouse-up and the click is lost (found in P2-05).
    reValidateMode: 'onChange',
  });

  useEffect(() => {
    if (sentTo) sentHeading.current?.focus();
  }, [sentTo]);

  const onSubmit = handleSubmit(async ({ email }) => {
    setFormError(null);
    try {
      await requestPasswordReset(email);
      setSentTo(email);
    } catch (error) {
      setFormError(authError(error));
    }
  });

  if (sentTo !== null) {
    return (
      <div data-auth-step="reset-requested" className="flex flex-col gap-4">
        <h2
          ref={sentHeading}
          tabIndex={-1}
          className="text-xl font-semibold text-text-primary outline-none"
        >
          {t('forgotPassword.sentTitle')}
        </h2>
        <p className="text-text-secondary wrap-anywhere">
          {t('forgotPassword.sentBody', {
            email: isolateBidi(sentTo),
            minutes: PASSWORD_RESET_LINK_MINUTES,
          })}
        </p>
        <Button asChild size="lg">
          <Link href={signInHref(null)}>{t('forgotPassword.backToSignIn')}</Link>
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
      <Button type="submit" size="lg" aria-disabled={isSubmitting}>
        {isSubmitting ? t('forgotPassword.submitting') : t('forgotPassword.submit')}
      </Button>
      <p className="text-sm text-text-secondary">
        {t('forgotPassword.rememberIt')}{' '}
        <Link
          href={signInHref(null)}
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          {t('forgotPassword.signIn')}
        </Link>
      </p>
    </form>
  );
}
