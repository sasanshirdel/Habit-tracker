'use client';

import { Skeleton } from '@habit/ui';
import { useTranslations } from 'next-intl';
import { useEffect, type ReactNode } from 'react';
import { QueryError } from '@/components/status/query-error';
import { signInHref } from '@/lib/auth/redirect';
import { useSession } from '@/lib/auth/session';
import { usePathname, useRouter } from '@/lib/i18n/navigation';

/**
 * Client-side page protection for the signed-in app (backlog P2-09, ADR-0020).
 *
 * The page content renders **only after** `GET /auth/session` said "signed in". Until then — and
 * in the server HTML, where the session cannot be known (the cookie lives on the API's origin) —
 * a neutral placeholder is shown, so a signed-out visitor never sees app content flash. Signed
 * out → `router.replace` to the sign-in page with this page as `next` (validated there, never an
 * open redirect); after an explicit sign-out, without `next`. A failed check (offline, API down)
 * shows the error with a retry instead of a misleading redirect.
 *
 * UX only: page components never hold user data (it comes from the API, which authorizes every
 * request), so the gate is not a security boundary and must not become one.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const t = useTranslations('auth.session');
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const state = session.data;

  useEffect(() => {
    if (state?.status !== 'signed-out') return;
    const here = `${pathname}${window.location.search}`;
    router.replace(signInHref(state.reason === 'signed-out' ? null : here));
  }, [state, pathname, router]);

  if (state?.status === 'signed-in') return <>{children}</>;

  if (session.isError && !state) {
    return (
      <div data-auth-gate="error" className="flex flex-col gap-4">
        <p className="text-text-secondary">{t('checkFailed')}</p>
        <QueryError error={session.error} onRetry={() => void session.refetch()} />
      </div>
    );
  }

  return (
    <div data-auth-gate="checking" aria-busy="true" className="flex flex-col gap-6">
      <p role="status" className="sr-only">
        {t('checking')}
      </p>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
