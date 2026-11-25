import { THEME_COOKIE, parseThemePreference } from '@habit/ui';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Brand } from './brand';
import { LanguageSwitcher } from './language-switcher';
import { MobileNav } from './mobile-nav';
import { RouteFocus } from './route-focus';
import { SidebarNav } from './sidebar-nav';
import { SkipLink } from './skip-link';

export const MAIN_ID = 'main';

/**
 * The application shell (backlog P1-11, ARCHITECTURE §7): skip link, primary navigation (sidebar
 * from `md`, bottom bar below), a banner with the language and theme switchers, and the `main`
 * region pages render into. Landmarks: `banner`, `navigation` (labelled), `main`.
 *
 * It shows navigation only — no user data and no access control. Authentication (Phase 2, P2-03)
 * adds the server-side session check to the `(app)` layout; nothing here pretends to authorize.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const [t, tTheme, cookieStore] = await Promise.all([
    getTranslations('shell'),
    getTranslations('theme'),
    cookies(),
  ]);

  return (
    <>
      <SkipLink targetId={MAIN_ID} label={t('skipToContent')} />
      <div className="flex min-h-dvh">
        <SidebarNav />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur md:px-8">
            <Brand className="md:hidden" />
            <div className="ms-auto flex items-center gap-2">
              <LanguageSwitcher />
              <ThemeSwitcher
                initial={parseThemePreference(cookieStore.get(THEME_COOKIE)?.value)}
                labels={{
                  label: tTheme('label'),
                  dark: tTheme('dark'),
                  light: tTheme('light'),
                  system: tTheme('system'),
                }}
              />
            </div>
          </header>
          <main
            id={MAIN_ID}
            tabIndex={-1}
            className="mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] outline-none md:px-8 md:pb-8"
          >
            {children}
          </main>
        </div>
      </div>
      <MobileNav />
      <RouteFocus targetId={MAIN_ID} />
    </>
  );
}
