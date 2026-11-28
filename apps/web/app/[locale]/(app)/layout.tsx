import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AuthGate } from '@/components/auth/auth-gate';
import { AppShell } from '@/components/shell/app-shell';

/**
 * Every page of the signed-in app renders inside the shell (backlog P1-11). The `(app)` group adds
 * no URL segment: `/{locale}/habits`, not `/{locale}/app/habits`.
 *
 * Page protection is client-side (P2-09, ADR-0020): the `__Host-session` cookie is host-only on the
 * API's origin, so this server never sees it (ADR-0019, open decision 1). `AuthGate` renders the
 * page only after `GET /auth/session` confirmed a session and otherwise sends the visitor to the
 * sign-in page. The navigation chrome is public; page content waits for the gate. The API remains
 * the authority (deny by default, P2-03), and server-rendered pages must never contain user data.
 * Kept out of search indexes.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Lets the bottom bar extend under the home indicator and pad itself with the safe area. */
export const viewport: Viewport = { viewportFit: 'cover' };

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell>
      <AuthGate>{children}</AuthGate>
    </AppShell>
  );
}
