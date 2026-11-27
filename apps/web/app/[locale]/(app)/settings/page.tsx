import { ChevronRightIcon, ShieldCheckIcon } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { sectionMetadata } from '@/components/shell/section-page';
import { parseLocale } from '@/lib/i18n/config';
import { Link } from '@/lib/i18n/navigation';

export const generateMetadata = sectionMetadata('settings');

type PageProps = { params: Promise<{ locale: string }> };

/**
 * `/{locale}/settings` — the list of settings pages. Since P2-08 it links to Sessions and security;
 * profile, preferences and the rest are added by the features that own them (ARCHITECTURE §7).
 * Static: no user data in the server HTML (ADR-0020).
 */
export default async function SettingsPage({ params }: PageProps) {
  const locale = parseLocale((await params).locale);
  if (!locale) notFound();
  setRequestLocale(locale);
  const [tNav, t] = await Promise.all([getTranslations('nav'), getTranslations('settings')]);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-text-primary md:text-3xl">{tNav('settings')}</h1>
      <ul className="flex flex-col gap-3" data-settings-pages="">
        <li>
          <Link
            href="/settings/security"
            className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4 outline-none hover:bg-surface-secondary focus-visible:ring-[3px] focus-visible:ring-accent/50"
          >
            <ShieldCheckIcon aria-hidden="true" className="size-6 shrink-0 text-text-secondary" />
            <span className="flex grow flex-col gap-1">
              <span className="font-medium text-text-primary">{t('security.title')}</span>
              <span className="text-sm text-text-secondary">{t('security.summary')}</span>
            </span>
            <ChevronRightIcon
              aria-hidden="true"
              className="size-5 shrink-0 text-text-secondary rtl:-scale-x-100"
            />
          </Link>
        </li>
      </ul>
      <p className="text-sm text-text-secondary">{t('more')}</p>
    </div>
  );
}
