import { getTranslations } from 'next-intl/server';
import { sections } from '@/lib/navigation/sections';
import { Brand } from './brand';
import { NavLink } from './nav-link';

/**
 * Primary navigation for tablet and desktop (P1-11): an icon rail from `md`, the full sidebar from
 * `lg`. It sits at the inline start — the left in LTR, the right in RTL — through flex order and
 * logical borders only. Hidden below `md`, where the bottom bar takes over.
 */
export async function SidebarNav() {
  const t = await getTranslations('nav');
  return (
    <nav
      aria-label={t('label')}
      data-nav="sidebar"
      className="sticky top-0 hidden h-dvh w-24 shrink-0 flex-col gap-4 overflow-y-auto border-e border-border bg-surface px-2 py-4 md:flex lg:w-64 lg:px-3"
    >
      <Brand className="justify-center lg:justify-start lg:px-3" />
      <ul className="flex flex-col gap-1">
        {sections.map((section) => (
          <li key={section.key}>
            <NavLink section={section} variant="sidebar" />
          </li>
        ))}
      </ul>
    </nav>
  );
}
