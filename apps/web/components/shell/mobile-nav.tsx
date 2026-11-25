'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, cn } from '@habit/ui';
import { EllipsisIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { usePathname } from '@/lib/i18n/navigation';
import {
  isActiveSection,
  mobileMoreSections,
  mobilePrimarySections,
} from '@/lib/navigation/sections';
import { NavLink } from './nav-link';

/**
 * Primary navigation on phones (P1-11): a bottom bar with the four most used sections and "More",
 * which opens a bottom sheet (Radix Dialog: focus trap, Escape, focus returns to "More") with the
 * remaining sections; choosing one moves focus to the new page. The bar follows the reading direction (Overview first at the inline start)
 * and keeps clear of the home indicator. Hidden from `md`, where the sidebar takes over.
 */
export function MobileNav() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Set when a sheet link leaves the page: focus then goes to the new page's main region
  // (RouteFocus) instead of back to "More".
  const leaving = useRef(false);
  const inMore = mobileMoreSections.some((s) => isActiveSection(pathname, s.href));

  return (
    <nav
      aria-label={t('label')}
      data-nav="bottom"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5">
        {mobilePrimarySections.map((section) => (
          <li key={section.key}>
            <NavLink section={section} variant="bar" />
          </li>
        ))}
        <li>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
              data-active={inMore ? 'true' : undefined}
              className={cn(
                'flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-[3px] focus-visible:ring-accent/50 focus-visible:outline-none',
                'data-[active=true]:bg-surface-secondary data-[active=true]:text-accent',
              )}
            >
              <EllipsisIcon aria-hidden="true" className="size-5" />
              <span>{t('more')}</span>
            </DialogTrigger>
            <DialogContent
              closeLabel={t('close')}
              onCloseAutoFocus={(event) => {
                if (leaving.current) event.preventDefault();
                leaving.current = false;
              }}
              aria-describedby={undefined}
              className="top-auto bottom-0 max-w-full translate-y-0 rounded-b-none pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:max-w-full data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom"
            >
              <DialogHeader>
                <DialogTitle>{t('moreTitle')}</DialogTitle>
              </DialogHeader>
              <nav aria-label={t('moreTitle')}>
                <ul className="flex flex-col gap-1">
                  {mobileMoreSections.map((section) => (
                    <li key={section.key}>
                      <NavLink
                        section={section}
                        variant="sheet"
                        onNavigate={() => {
                          leaving.current = !isActiveSection(pathname, section.href);
                          setOpen(false);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </nav>
            </DialogContent>
          </Dialog>
        </li>
      </ul>
    </nav>
  );
}
