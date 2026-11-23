import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale } from '@/lib/i18n/config';
import { getDictionary } from '@/lib/i18n/dictionaries';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getDictionary(locale);
  const other = locale === 'fa' ? 'en' : 'fa';

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold text-text-primary">{t.home.heading}</h1>
      <p className="text-text-secondary">{t.home.subheading}</p>
      {/* Logical properties (ms/me, ps/pe, start/end) only — never left/right — so RTL mirrors correctly. */}
      <Link
        href={`/${other}`}
        hrefLang={other}
        className="self-start rounded-md border border-border bg-surface px-4 py-2 text-accent"
      >
        {t.home.switchLanguage}
      </Link>
    </main>
  );
}
