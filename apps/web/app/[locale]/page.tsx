import { Button, THEME_COOKIE, parseThemePreference } from '@habit/ui';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { parseLocale } from '@/lib/i18n/config';
import { Link } from '@/lib/i18n/navigation';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = parseLocale((await params).locale);
  if (!locale) notFound();
  setRequestLocale(locale);
  const [t, tLanguage, tTheme, cookieStore] = await Promise.all([
    getTranslations('home'),
    getTranslations('language'),
    getTranslations('theme'),
    cookies(),
  ]);
  const other = locale === 'fa' ? 'en' : 'fa';
  const now = new Date();

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold text-text-primary">{t('heading')}</h1>
      <p className="text-text-secondary">{t('subheading')}</p>
      <p className="text-text-secondary">
        <time dateTime={now.toISOString()}>{t('today', { date: now })}</time>
      </p>
      {/*
        Landing vs app (ROADMAP decision #10, interim since P2-09): the landing page stays at
        /{locale} and links to sign-up and sign-in; a signed-in visitor who follows "Sign in" is
        sent straight on to the app. No automatic redirect from here (no session check on the
        public page). Reversible: one place to change.
      */}
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link href="/auth/sign-up">{t('signUp')}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/auth/sign-in">{t('signIn')}</Link>
        </Button>
      </div>
      {/* Logical properties (ms/me, ps/pe, start/end) only — never left/right — so RTL mirrors correctly. */}
      <nav aria-label={tLanguage('label')} className="flex items-center gap-2">
        <Button asChild variant="outline">
          <Link href="/" locale={other} hrefLang={other} lang={other}>
            {tLanguage('switchTo')}
          </Link>
        </Button>
        <ThemeSwitcher
          initial={parseThemePreference(cookieStore.get(THEME_COOKIE)?.value)}
          labels={{
            label: tTheme('label'),
            dark: tTheme('dark'),
            light: tTheme('light'),
            system: tTheme('system'),
          }}
        />
      </nav>
      <Link
        href="/status"
        className="self-start text-sm text-accent underline-offset-4 hover:underline"
      >
        {t('status')}
      </Link>
    </main>
  );
}
