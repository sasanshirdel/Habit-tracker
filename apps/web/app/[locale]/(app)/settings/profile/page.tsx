import { ChevronLeftIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ProfileSettings } from '@/components/settings/profile-settings';
import { parseLocale } from '@/lib/i18n/config';
import { Link } from '@/lib/i18n/navigation';

type PageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const locale = parseLocale((await params).locale);
  if (!locale) return {};
  const [t, tMeta] = await Promise.all([
    getTranslations({ locale, namespace: 'settings.profile' }),
    getTranslations({ locale, namespace: 'meta' }),
  ]);
  return { title: `${t('title')} · ${tMeta('title')}` };
}

/**
 * `/{locale}/settings/profile` (backlog P2-07, ADR-0024). The server renders only the static
 * frame; the form loads in the browser after the `AuthGate` confirmed the session (ADR-0020: no
 * user data in server HTML).
 */
export default async function ProfileSettingsPage({ params }: PageProps) {
  const locale = parseLocale((await params).locale);
  if (!locale) notFound();
  setRequestLocale(locale);
  const [tNav, t] = await Promise.all([
    getTranslations('nav'),
    getTranslations('settings.profile'),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 self-start rounded-md text-sm text-text-secondary outline-none hover:text-text-primary focus-visible:ring-[3px] focus-visible:ring-accent/50"
        >
          <ChevronLeftIcon aria-hidden="true" className="size-4 rtl:-scale-x-100" />
          {tNav('settings')}
        </Link>
        <h1 className="text-2xl font-semibold text-text-primary md:text-3xl">{t('title')}</h1>
        <p className="text-text-secondary">{t('description')}</p>
      </div>
      <ProfileSettings />
    </div>
  );
}
