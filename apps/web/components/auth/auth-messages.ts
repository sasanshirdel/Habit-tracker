'use client';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@habit/shared-validation';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { FieldError } from 'react-hook-form';
import { useErrorMessage } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';

/** The lockout policy name the API reports in `details.policy` (ADR-0018). */
export const LOGIN_LOCKOUT_POLICY = 'login-account';
/** Per-account limit on new verification links (`details.policy`, ADR-0021). */
export const VERIFICATION_EMAIL_POLICY = 'verification-email';

function minutesFrom(seconds: number | undefined): number {
  return Math.max(1, Math.ceil((seconds ?? 60) / 60));
}

/**
 * The form-level message for a failed sign-in or sign-up (backlog P2-09). It never says whether
 * an account exists: `INVALID_CREDENTIALS` is the API's single answer for an unknown address and
 * a wrong password, and registration always answers 202. Rate limits say how long to wait — the
 * per-address lockout (`policy: login-account`, which also applies to addresses with no account)
 * and the per-device `auth` limit get their own wording. Anything else uses the app-wide message
 * for its code.
 */
export function useAuthErrorMessage(): (error: unknown) => string {
  const t = useTranslations('auth.errors');
  const generic = useErrorMessage();
  return useCallback(
    (error: unknown) => {
      if (!isApiError(error)) return generic(error);
      switch (error.code) {
        case 'INVALID_CREDENTIALS':
          return t('invalidCredentials');
        case 'RATE_LIMITED': {
          const policy = (error.details as { policy?: unknown } | undefined)?.policy;
          const minutes = minutesFrom(error.retryAfterSeconds);
          if (policy === LOGIN_LOCKOUT_POLICY) return t('locked', { minutes });
          if (policy === VERIFICATION_EMAIL_POLICY) return t('resendTooSoon', { minutes });
          return t('tooManyAttempts', { minutes });
        }
        case 'VALIDATION_FAILED':
          return t('invalidInput');
        default:
          return generic(error);
      }
    },
    [t, generic],
  );
}

/** Localized text for a field error from the shared schemas (codes, see `schemaResolver`). */
export function useFieldErrorMessage(): (
  field: 'email' | 'password',
  error: FieldError | undefined,
  value: string,
) => string | undefined {
  const t = useTranslations('auth.validation');
  return useCallback(
    (field, error, value) => {
      if (!error) return undefined;
      if (field === 'email') return value.trim() === '' ? t('emailRequired') : t('emailInvalid');
      if (value === '') return t('passwordRequired');
      if (error.type === 'too_big') return t('passwordTooLong', { max: PASSWORD_MAX_LENGTH });
      return t('passwordTooShort', { min: PASSWORD_MIN_LENGTH });
    },
    [t],
  );
}
