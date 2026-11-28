'use client';

import { QueryClientProvider, isServer } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getQueryClient } from '@/lib/api/query-client';
import { watchSessionExpiry } from '@/lib/auth/session';

/** TanStack Query for client components (backlog P1-12). Mounted once in the locale layout. */
export function QueryProvider({ children }: { children: ReactNode }) {
  // Not useState: on the server a new client per render; in the browser the tab's singleton,
  // which also survives a suspense boundary remounting this provider.
  const queryClient = getQueryClient();
  // Any 401 from the API re-checks the session (P2-09, ADR-0027). Connected during render, not in
  // an effect: children's queries start before a parent's effects run. Idempotent per client.
  if (!isServer) watchSessionExpiry(queryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
