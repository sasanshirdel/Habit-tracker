'use client';

import { Button } from '@habit/ui';
import { CircleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useErrorMessage } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';

/**
 * The standard error state for data that failed to load (backlog P1-12): the localized message
 * for the error's code, the request ID to quote to support, and a retry button. Announced to
 * assistive technology (`role="alert"`).
 */
export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTranslations('apiErrors');
  const message = useErrorMessage();
  const requestId = isApiError(error) ? error.requestId : undefined;
  return (
    <div
      role="alert"
      data-error-code={isApiError(error) ? error.code : 'UNKNOWN'}
      className="flex flex-col items-start gap-3 rounded-lg border border-danger/50 bg-surface p-4"
    >
      <p className="flex items-start gap-2 text-text-primary">
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
        <span>{message(error)}</span>
      </p>
      {requestId ? (
        <p className="text-sm text-text-secondary">
          {/* First-strong isolates keep the Latin ID in one piece inside Persian text. */}
          {t('reference', { requestId: `\u2068${requestId}\u2069` })}
        </p>
      ) : null}
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      ) : null}
    </div>
  );
}
