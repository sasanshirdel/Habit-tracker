'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from '@habit/ui';
import { useQueryClient } from '@tanstack/react-query';
import { CircleUserRoundIcon, LogOutIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { signOut } from '@/lib/auth/actions';
import { useSession } from '@/lib/auth/session';

/**
 * The account menu in the app's banner (backlog P2-09): who is signed in, and "Sign out". It
 * renders nothing until the session is known (the gate shows the placeholder meanwhile). Signing
 * out calls `POST /auth/logout` with the in-memory CSRF token; only when the API confirms are the
 * cached data and the token dropped, and the gate then moves to the sign-in page. A failure keeps
 * the user signed in and says so.
 */
export function AccountMenu() {
  const t = useTranslations('auth.session');
  const queryClient = useQueryClient();
  const session = useSession();
  const [pending, setPending] = useState(false);

  if (session.data?.status !== 'signed-in') return null;
  const { email } = session.data.user;

  async function onSignOut() {
    if (pending) return;
    setPending(true);
    try {
      await signOut(queryClient);
      toast({ title: t('signedOut'), variant: 'success' });
    } catch {
      toast({ title: t('signOutFailed'), variant: 'error' });
      setPending(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t('account')} data-account-menu="">
          <CircleUserRoundIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        <DropdownMenuLabel className="font-normal break-all text-text-secondary">
          {t('signedInAs', { email: `\u2068${email}\u2069` })}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pending} onSelect={() => void onSignOut()}>
          <LogOutIcon aria-hidden="true" className="rtl:-scale-x-100" />
          {pending ? t('signingOut') : t('signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
