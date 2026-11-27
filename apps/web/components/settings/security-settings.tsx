'use client';

import {
  SECURITY_EVENT_RETENTION_DAYS,
  type AccountSession,
  type ClientDescription,
  type ClientDevice,
  type SecurityEvent,
} from '@habit/shared-types';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  toast,
} from '@habit/ui';
import {
  HistoryIcon,
  LaptopIcon,
  MonitorSmartphoneIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  TabletIcon,
  type LucideIcon,
} from 'lucide-react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import { useState } from 'react';
import { QueryError } from '@/components/status/query-error';
import { useDateDisplay } from '@/lib/account/preferences';
import {
  useAccountSessions,
  useRevokeOtherSessions,
  useRevokeSession,
  useSecurityEvents,
} from '@/lib/auth/account';

/**
 * Settings → Sessions and security (backlog P2-08, ADR-0023): where the account is signed in
 * (current device marked, sign out one or all others, each confirmed in a dialog) and the recent
 * security activity. Rendered only inside `AuthGate`, i.e. in the browser after the session check,
 * so dates use the profile's time zone and calendar (P2-07, `useDateDisplay`).
 */
export function SecuritySettings() {
  return (
    <div className="flex flex-col gap-10">
      <SessionsSection />
      <ActivitySection />
    </div>
  );
}

const deviceIcons: Record<ClientDevice, LucideIcon> = {
  desktop: LaptopIcon,
  mobile: SmartphoneIcon,
  tablet: TabletIcon,
  unknown: MonitorSmartphoneIcon,
};

/** First-strong isolates keep Latin product names in one piece inside Persian text. */
const isolate = (text: string) => `\u2068${text}\u2069`;

function useClientLabel() {
  const t = useTranslations('settings.security');
  return (client: ClientDescription) =>
    t('client', {
      browser: isolate(t(`browsers.${client.browser}`)),
      os: isolate(t(`oses.${client.os}`)),
    });
}

function SessionsSection() {
  const t = useTranslations('settings.security.sessions');
  const sessions = useAccountSessions();
  const revokeOthers = useRevokeOtherSessions();
  const [confirmOthers, setConfirmOthers] = useState(false);
  const all = sessions.data?.pages.flatMap((page) => page.data) ?? [];
  const others = all.filter((s) => !s.current);

  async function onRevokeOthers() {
    try {
      const { revoked } = await revokeOthers.mutateAsync();
      setConfirmOthers(false);
      toast({ title: t('revokedOthers', { count: revoked }), variant: 'success' });
    } catch {
      toast({ title: t('revokeFailed'), variant: 'error' });
    }
  }

  return (
    <section
      aria-labelledby="sessions-title"
      aria-busy={sessions.isPending}
      className="flex flex-col gap-4"
      data-sessions=""
    >
      <div className="flex flex-col gap-1">
        <h2 id="sessions-title" className="text-lg font-semibold text-text-primary">
          {t('title')}
        </h2>
        <p className="text-sm text-text-secondary">{t('description')}</p>
      </div>

      {sessions.isPending ? (
        <div className="flex flex-col gap-3">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : sessions.isError ? (
        <QueryError error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {all.map((session) => (
              <SessionItem key={session.id} session={session} />
            ))}
          </ul>
          {sessions.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={sessions.isFetchingNextPage}
              onClick={() => void sessions.fetchNextPage()}
            >
              {t('showMore')}
            </Button>
          ) : null}
          {others.length === 0 && !sessions.hasNextPage ? (
            <p className="text-sm text-text-secondary" data-only-this-device="">
              {t('onlyThisDevice')}
            </p>
          ) : (
            <Dialog open={confirmOthers} onOpenChange={setConfirmOthers}>
              <Button
                variant="outline"
                className="self-start"
                onClick={() => setConfirmOthers(true)}
                data-revoke-others=""
              >
                {t('revokeOthers')}
              </Button>
              <DialogContent closeLabel={t('cancel')}>
                <DialogHeader>
                  <DialogTitle>{t('revokeOthersTitle')}</DialogTitle>
                  <DialogDescription>{t('revokeOthersDescription')}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline">{t('cancel')}</Button>
                  </DialogClose>
                  <Button
                    variant="danger"
                    disabled={revokeOthers.isPending}
                    onClick={() => void onRevokeOthers()}
                  >
                    {revokeOthers.isPending ? t('revoking') : t('revokeOthersConfirm')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </>
      )}
      <p className="text-xs text-text-secondary">{t('privacy')}</p>
    </section>
  );
}

function SessionItem({ session }: { session: AccountSession }) {
  const t = useTranslations('settings.security');
  const tSessions = useTranslations('settings.security.sessions');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const display = useDateDisplay();
  const clientLabel = useClientLabel();
  const revoke = useRevokeSession();
  const [confirming, setConfirming] = useState(false);
  const Icon = deviceIcons[session.client.device];
  const label = clientLabel(session.client);
  const lastActive = new Date(session.lastActiveAt);
  // "Just now" rather than "in 3 seconds" when clocks disagree slightly.
  const lastActiveShown = lastActive.getTime() > now.getTime() ? now : lastActive;

  async function onRevoke() {
    try {
      await revoke.mutateAsync({ id: session.id, current: session.current });
      setConfirming(false);
      toast({ title: tSessions('revoked'), variant: 'success' });
    } catch {
      toast({ title: tSessions('revokeFailed'), variant: 'error' });
    }
  }

  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center"
      data-session-id={session.id}
      data-current={session.current ? '' : undefined}
    >
      <Icon aria-hidden="true" className="size-6 shrink-0 text-text-secondary" />
      <div className="flex min-w-0 grow flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 font-medium text-text-primary">
          <span>{label}</span>
          <span className="text-sm font-normal text-text-secondary">
            ({t(`devices.${session.client.device}`)})
          </span>
          {session.current ? (
            <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
              {tSessions('thisDevice')}
            </span>
          ) : null}
        </p>
        <p className="text-sm text-text-secondary">
          {session.current
            ? tSessions('activeNow')
            : tSessions('lastActive', {
                ago: format.relativeTime(lastActiveShown, now),
              })}
          {' · '}
          {tSessions('signedIn', {
            when: format.dateTime(new Date(session.createdAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
              ...display,
            }),
          })}
        </p>
      </div>
      {session.current ? null : (
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <Button
            variant="outline"
            size="sm"
            className="self-start sm:self-center"
            aria-label={tSessions('revokeLabel', { client: label })}
            onClick={() => setConfirming(true)}
          >
            {tSessions('revoke')}
          </Button>
          <DialogContent closeLabel={tSessions('cancel')}>
            <DialogHeader>
              <DialogTitle>{tSessions('revokeTitle')}</DialogTitle>
              <DialogDescription>
                {tSessions('revokeDescription', { client: label })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">{tSessions('cancel')}</Button>
              </DialogClose>
              <Button variant="danger" disabled={revoke.isPending} onClick={() => void onRevoke()}>
                {revoke.isPending ? tSessions('revoking') : tSessions('revokeConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </li>
  );
}

function ActivitySection() {
  const t = useTranslations('settings.security.activity');
  const events = useSecurityEvents();
  const all = events.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section
      aria-labelledby="activity-title"
      aria-busy={events.isPending}
      className="flex flex-col gap-4"
      data-security-events=""
    >
      <div className="flex flex-col gap-1">
        <h2 id="activity-title" className="text-lg font-semibold text-text-primary">
          {t('title')}
        </h2>
        <p className="text-sm text-text-secondary">
          {t('description', { days: SECURITY_EVENT_RETENTION_DAYS })}
        </p>
      </div>
      {events.isPending ? (
        <div className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : events.isError ? (
        <QueryError error={events.error} onRetry={() => void events.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState icon={<HistoryIcon />} title={t('empty')} />
      ) : (
        <>
          <ol className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {all.map((event) => (
              <EventItem key={event.id} event={event} />
            ))}
          </ol>
          {events.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={events.isFetchingNextPage}
              onClick={() => void events.fetchNextPage()}
            >
              {t('showMore')}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

function EventItem({ event }: { event: SecurityEvent }) {
  const t = useTranslations('settings.security.activity');
  const format = useFormatter();
  const display = useDateDisplay();
  const clientLabel = useClientLabel();
  const occurredAt = new Date(event.occurredAt);
  return (
    <li className="flex items-start gap-3 p-3" data-event-type={event.type}>
      <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-text-secondary" />
      <div className="flex min-w-0 flex-col">
        <p className="font-medium text-text-primary">{t(`events.${event.type}`)}</p>
        <p className="text-sm text-text-secondary">
          {clientLabel(event.client)}
          {' · '}
          <time dateTime={event.occurredAt}>
            {format.dateTime(occurredAt, { dateStyle: 'medium', timeStyle: 'short', ...display })}
          </time>
        </p>
      </div>
    </li>
  );
}
