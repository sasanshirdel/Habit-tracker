'use client';

import { signInCredentialsSchema, type SignInCredentials } from '@habit/shared-validation';
import { Alert, Button } from '@habit/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { signIn } from '@/lib/auth/actions';
import { afterSignInPath, forgotPasswordHref, signUpHref } from '@/lib/auth/redirect';
import { useSession } from '@/lib/auth/session';
import { schemaResolver } from '@/lib/forms/schema-resolver';
import { applyServerFieldErrors } from '@/lib/forms/server-errors';
import { Link, useRouter } from '@/lib/i18n/navigation';
import { useAuthErrorMessage, useFieldErrorMessage } from './auth-messages';
import { EmailField, PasswordField } from './credential-fields';

type SignInFields = { email: string; password: string };

/**
 * Sign-in form (backlog P2-09). Validates with the API's own schema for instant feedback, posts
 * to `POST /auth/login`, keeps the CSRF token from the response in memory, then goes to the
 * (sanitised) `next` page or the app's home. A wrong address and a wrong password get the same
 * message (the API cannot tell them apart either); the password is cleared and focused for the
 * next try. A visitor who is already signed in is sent on without seeing the form submit.
 * "Forgot your password?" leads to the reset request page (P2-05). After the session ended under
 * an open page (ADR-0027) a note says so.
 */
export function SignInForm({ next }: { next: string | null }) {
  const t = useTranslations('auth');
  const queryClient = useQueryClient();
  const router = useRouter();
  const session = useSession();
  const authError = useAuthErrorMessage();
  const fieldError = useFieldErrorMessage();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    setFocus,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignInFields, unknown, SignInCredentials>({
    resolver: schemaResolver<SignInFields, SignInCredentials>(signInCredentialsSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onSubmit',
    // After a failed submit, re-check while typing, not on blur: a message vanishing on blur moves
    // the submit button between mouse-down and mouse-up and the click is lost (found in P2-05).
    reValidateMode: 'onChange',
  });

  const signedIn = session.data?.status === 'signed-in';
  // Sent here because a request found the session gone (ADR-0027): say why.
  const expired = session.data?.status === 'signed-out' && session.data.reason === 'expired';
  useEffect(() => {
    if (signedIn) router.replace(afterSignInPath(next));
  }, [signedIn, next, router]);

  const onSubmit = handleSubmit(async (credentials) => {
    setFormError(null);
    try {
      await signIn(queryClient, credentials);
      // The effect above navigates once the cached session says "signed in".
    } catch (error) {
      // A field the API refused (rare: same shared schema) is marked on the field itself.
      if (applyServerFieldErrors(error, { setError, setFocus }, ['email', 'password'])) return;
      setFormError(authError(error));
      setValue('password', '');
      setFocus('password');
    }
  });

  return (
    <form
      noValidate
      // One request at a time: a second Enter/click while submitting does nothing.
      onSubmit={(event) => (isSubmitting ? event.preventDefault() : void onSubmit(event))}
      aria-busy={isSubmitting}
      className="flex flex-col gap-5"
    >
      {formError ? (
        <Alert tone="danger">{formError}</Alert>
      ) : expired ? (
        <Alert tone="info" data-session-expired="">
          {t('session.expired')}
        </Alert>
      ) : null}
      <EmailField
        autoComplete="username"
        registration={register('email')}
        error={fieldError('email', errors.email, getValues('email'))}
      />
      <PasswordField
        autoComplete="current-password"
        registration={register('password')}
        error={fieldError('password', errors.password, getValues('password'))}
      />
      <p className="-mt-2 text-end text-sm">
        <Link
          href={forgotPasswordHref}
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          {t('signIn.forgotPassword')}
        </Link>
      </p>
      <Button type="submit" size="lg" aria-disabled={isSubmitting || signedIn}>
        {isSubmitting ? t('signIn.submitting') : t('signIn.submit')}
      </Button>
      <p className="text-sm text-text-secondary">
        {t('signIn.noAccount')}{' '}
        <Link
          href={signUpHref(next)}
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          {t('signIn.createAccount')}
        </Link>
      </p>
    </form>
  );
}
