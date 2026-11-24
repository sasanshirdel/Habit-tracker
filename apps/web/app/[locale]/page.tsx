import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { parseLocale } from '@/lib/i18n/config';
import { Link } from '@/lib/i18n/navigation';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = parseLocale((await params).locale);
  if (!locale) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const tLanguage = await getTranslations('language');
  const other = locale === 'fa' ? 'en' : 'fa';
  const now = new Date();

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold text-text-primary">{t('heading')}</h1>
      <p className="text-text-secondary">{t('subheading')}</p>
      <p className="text-text-secondary">
        <time dateTime={now.toISOString()}>{t('today', { date: now })}</time>
      </p>
      {/* Logical properties (ms/me, ps/pe, start/end) only — never left/right — so RTL mirrors correctly. */}
      <nav aria-label={tLanguage('label')}>
        <Link
          href="/"
          locale={other}
          hrefLang={other}
          lang={other}
          className="inline-block rounded-md border border-border bg-surface px-4 py-2 text-accent"
        >
          {tLanguage('switchTo')}
        </Link>
      </nav>
    </main>
  );
}
