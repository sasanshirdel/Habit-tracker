'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getQueryClient } from '@/lib/api/query-client';

/** TanStack Query for client components (backlog P1-12). Mounted once in the locale layout. */
export function QueryProvider({ children }: { children: ReactNode }) {
  // Not useState: on the server a new client per render; in the browser the tab's singleton,
  // which also survives a suspense boundary remounting this provider.
  const queryClient = getQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
