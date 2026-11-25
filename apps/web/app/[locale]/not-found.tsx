import { Button } from '@habit/ui';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/lib/i18n/navigation';

/** Localized 404 for every path under `/{locale}` (the locale layout supplies `lang`/`dir`). */
export default async function NotFound() {
  const t = await getTranslations('notFound');
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold text-text-primary">{t('title')}</h1>
      <p className="text-text-secondary">{t('description')}</p>
      <Button asChild variant="outline" className="self-start">
        <Link href="/">{t('backHome')}</Link>
      </Button>
    </main>
  );
}
