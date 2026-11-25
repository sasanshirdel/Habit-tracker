import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';

/**
 * Every page of the signed-in app renders inside the shell (backlog P1-11). The `(app)` group adds
 * no URL segment: `/{locale}/habits`, not `/{locale}/app/habits`.
 *
 * No authentication exists yet (Phase 2), so these pages are reachable by anyone and contain no
 * user data. P2-03 adds the server-side session check here; until then the placeholders are kept
 * out of search indexes.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Lets the bottom bar extend under the home indicator and pad itself with the safe area. */
export const viewport: Viewport = { viewportFit: 'cover' };

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
