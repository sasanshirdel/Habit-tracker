import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { HealthStatus } from '@/components/status/health-status';
import { parseLocale } from '@/lib/i18n/config';
import { Link } from '@/lib/i18n/navigation';

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const locale = parseLocale((await params).locale);
  if (!locale) return {};
  const [t, tMeta] = await Promise.all([
    getTranslations({ locale, namespace: 'status' }),
    getTranslations({ locale, namespace: 'meta' }),
  ]);
  return { title: `${t('title')} · ${tMeta('title')}`, robots: { index: false } };
}

/**
 * Public system status page — the P1-12 demo of the frontend data layer. The checks run in the
 * browser (client component), through the same client and query defaults every feature uses.
 */
export default async function StatusPage({ params }: PageProps) {
  const locale = parseLocale((await params).locale);
  if (!locale) notFound();
  setRequestLocale(locale);
  const [t, tNotFound] = await Promise.all([
    getTranslations('status'),
    getTranslations('notFound'),
  ]);
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-6 py-10">
      <Link href="/" className="self-start text-sm text-accent underline-offset-4 hover:underline">
        {tNotFound('backHome')}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-text-primary">{t('title')}</h1>
        <p className="text-text-secondary">{t('description')}</p>
      </div>
      <HealthStatus />
    </main>
  );
}
