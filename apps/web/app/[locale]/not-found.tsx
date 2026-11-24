import { getTranslations } from 'next-intl/server';
import { Link } from '@/lib/i18n/navigation';

/** Localized 404 for every path under `/{locale}` (the locale layout supplies `lang`/`dir`). */
export default async function NotFound() {
  const t = await getTranslations('notFound');
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold text-text-primary">{t('title')}</h1>
      <p className="text-text-secondary">{t('description')}</p>
      <Link
        href="/"
        className="self-start rounded-md border border-border bg-surface px-4 py-2 text-accent"
      >
        {t('backHome')}
      </Link>
    </main>
  );
}
