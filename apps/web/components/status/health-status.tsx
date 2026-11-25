'use client';

import type { DependencyStatus, ReadinessChecks } from '@habit/shared-types';
import { Button, Skeleton, cn } from '@habit/ui';
import { useQuery } from '@tanstack/react-query';
import { CircleCheckIcon, CircleXIcon, RefreshCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { healthQueries } from '@/lib/api/queries/health';
import type { ApiClient } from '@/lib/api/client';
import { QueryError } from './query-error';

/**
 * Health status demo (backlog P1-12): the API's liveness and readiness through the typed client
 * and TanStack Query, with the standard loading (skeleton, `aria-busy`), error (localized by
 * code, request ID, retry) and success states. Refreshes every 30 s and on demand.
 */
export function HealthStatus({ client }: { client?: ApiClient }) {
  const t = useTranslations('status');
  const queries = healthQueries(client);
  const live = useQuery(queries.live());
  const ready = useQuery(queries.ready());
  const fetching = live.isFetching || ready.isFetching;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={fetching}
          onClick={() => {
            void live.refetch();
            void ready.refetch();
          }}
        >
          <RefreshCwIcon aria-hidden="true" className={cn(fetching && 'animate-spin')} />
          {fetching ? t('checking') : t('refresh')}
        </Button>
        {live.dataUpdatedAt ? (
          <p className="text-sm text-text-secondary" aria-live="polite">
            {t('lastChecked', { time: new Date(live.dataUpdatedAt) })}
          </p>
        ) : null}
      </div>

      <section
        aria-labelledby="status-api"
        aria-busy={live.isPending}
        className="flex flex-col gap-3"
      >
        <h2 id="status-api" className="text-lg font-semibold text-text-primary">
          {t('api')}
        </h2>
        {live.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : live.isError ? (
          <QueryError error={live.error} onRetry={() => void live.refetch()} />
        ) : (
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
            <StatusLine status="up" label={t('apiUp')} />
            <p className="text-sm text-text-secondary">
              {t('uptime', {
                hours: Math.floor(live.data.uptimeSeconds / 3600),
                minutes: Math.floor((live.data.uptimeSeconds % 3600) / 60),
              })}
            </p>
          </div>
        )}
      </section>

      <section
        aria-labelledby="status-ready"
        aria-busy={ready.isPending}
        className="flex flex-col gap-3"
      >
        <h2 id="status-ready" className="text-lg font-semibold text-text-primary">
          {t('readiness')}
        </h2>
        {ready.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : ready.isError ? (
          <QueryError error={ready.error} onRetry={() => void ready.refetch()} />
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
            <p className="text-text-primary">{ready.data.ready ? t('allReady') : t('notReady')}</p>
            <Checks checks={ready.data.checks} />
          </div>
        )}
      </section>
    </div>
  );
}

function Checks({ checks }: { checks: ReadinessChecks }) {
  const t = useTranslations('status');
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
      {(['database', 'redis'] as const).map((key) => (
        <div key={key} className="contents">
          <dt className="text-text-secondary">{t(key)}</dt>
          <dd data-check={key} data-status={checks[key]}>
            <StatusLine status={checks[key]} label={t(checks[key])} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatusLine({ status, label }: { status: DependencyStatus; label: string }) {
  const Icon = status === 'up' ? CircleCheckIcon : CircleXIcon;
  return (
    <span className="inline-flex items-center gap-2 font-medium text-text-primary">
      <Icon
        aria-hidden="true"
        className={cn('size-5', status === 'up' ? 'text-accent' : 'text-danger')}
      />
      {label}
    </span>
  );
}
