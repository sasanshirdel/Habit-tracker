'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from '@/lib/i18n/navigation';

/**
 * Focus management for client-side navigation (P1-11): after the path changes, focus moves to the
 * main region, so keyboard and screen-reader users start on the new page instead of on the link
 * they used (which may have just closed with the "More" sheet). Not on the first render — a fresh
 * page load starts at the top, with the skip link first.
 */
export function RouteFocus({ targetId }: { targetId: string }) {
  const pathname = usePathname();
  const previous = useRef(pathname);

  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    document.getElementById(targetId)?.focus();
  }, [pathname, targetId]);

  return null;
}
