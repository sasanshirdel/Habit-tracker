import { THEME_COOKIE, parseThemePreference } from '@habit/ui';
import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { Brand } from '@/components/shell/brand';
import { LanguageSwitcher } from '@/components/shell/language-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';

/**
 * Public authentication pages (backlog P2-09) under `/{locale}/auth/*` (ARCHITECTURE §7):
 * `/auth/sign-in` and `/auth/sign-up`, outside the app shell. A
 * banner with the brand (to the landing page) and the language/theme switchers, then one centred
 * column that reads the same in RTL and LTR (logical properties only).
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const [tTheme, cookieStore] = await Promise.all([getTranslations('theme'), cookies()]);
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center gap-2 px-4 md:px-8">
        <Brand href="/" rail={false} />
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
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col items-center px-4 pt-8 pb-16 outline-none md:pt-16"
      >
        <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6 shadow-sm md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
