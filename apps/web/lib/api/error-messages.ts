'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { isApiError } from './errors';

/**
 * Localized text for any error thrown by the API client (backlog P1-12): one `apiErrors.<CODE>`
 * message per API and client code in `en.json`/`fa.json` (a test checks every code), and
 * `apiErrors.UNKNOWN` for anything else. `RATE_LIMITED` includes the wait when it is known.
 */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations('apiErrors');
  return useCallback(
    (error: unknown) => {
      if (!isApiError(error)) return t('UNKNOWN');
      if (error.code === 'RATE_LIMITED') {
        return t('RATE_LIMITED', { seconds: error.retryAfterSeconds ?? 0 });
      }
      return t(error.code);
    },
    [t],
  );
}
