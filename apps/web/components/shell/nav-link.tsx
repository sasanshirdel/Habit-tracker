'use client';

import { cn } from '@habit/ui';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/lib/i18n/navigation';
import { isActiveSection, type Section } from '@/lib/navigation/sections';
import { sectionIcons } from './section-icons';

export type NavLinkVariant = 'sidebar' | 'bar' | 'sheet';

const variants: Record<NavLinkVariant, string> = {
  // Tablet: icon over a short label in a narrow rail. Desktop: icon beside the label.
  sidebar:
    'flex flex-col items-center gap-1 px-1 py-2 text-center text-xs lg:flex-row lg:gap-3 lg:px-3 lg:text-start lg:text-sm',
  // Mobile bottom bar: ≥ 56 px tall touch targets.
  bar: 'flex min-h-14 flex-col items-center justify-center gap-1 px-1 py-1.5 text-center text-xs',
  // "More" sheet: full-width rows.
  sheet: 'flex min-h-12 items-center gap-3 px-3 py-2 text-base',
};

export interface NavLinkProps {
  section: Section;
  variant: NavLinkVariant;
  /** Called after the link is activated (the "More" sheet closes itself with it). */
  onNavigate?: () => void;
}

/**
 * A primary-navigation link (P1-11). Marks the current section with `aria-current="page"` (also
 * for pages below it, e.g. `/habits/123`), and flips direction-bearing icons in RTL.
 */
export function NavLink({ section, variant, onNavigate }: NavLinkProps) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const active = isActiveSection(pathname, section.href);
  const Icon = sectionIcons[section.key];

  return (
    <Link
      href={section.href}
      aria-current={active ? 'page' : undefined}
      data-section={section.key}
      onClick={onNavigate}
      className={cn(
        'rounded-md font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-[3px] focus-visible:ring-accent/50 focus-visible:outline-none',
        'aria-[current=page]:bg-surface-secondary aria-[current=page]:text-accent',
        variants[variant],
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-5 shrink-0', section.mirrorInRtl && 'rtl:-scale-x-100')}
      />
      <span className="min-w-0 break-words">{t(section.key)}</span>
    </Link>
  );
}
