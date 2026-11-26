import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';

/**
 * Every page of the signed-in app renders inside the shell (backlog P1-11). The `(app)` group adds
 * no URL segment: `/{locale}/habits`, not `/{locale}/app/habits`.
 *
 * The API denies every unauthenticated request since P2-03, but these pages do not check the session
 * yet: the `__Host-session` cookie is host-only on the API's origin, so this server never sees it
 * (ADR-0019, open decision 1). P2-09 adds a client-side redirect based on `GET /auth/session`. The
 * placeholders contain no user data and are kept out of search indexes.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Lets the bottom bar extend under the home indicator and pad itself with the safe area. */
export const viewport: Viewport = { viewportFit: 'cover' };

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
