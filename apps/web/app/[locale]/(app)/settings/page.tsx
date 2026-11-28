import {
  ChevronRightIcon,
  DatabaseIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { sectionMetadata } from '@/components/shell/section-page';
import { parseLocale } from '@/lib/i18n/config';
import { Link } from '@/lib/i18n/navigation';

export const generateMetadata = sectionMetadata('settings');

type PageProps = { params: Promise<{ locale: string }> };

/** The settings pages that exist so far, in display order (ARCHITECTURE §7). */
const PAGES: readonly {
  key: 'profile' | 'preferences' | 'security' | 'privacy';
  icon: LucideIcon;
}[] = [
  { key: 'profile', icon: UserRoundIcon },
  { key: 'preferences', icon: SlidersHorizontalIcon },
  { key: 'security', icon: ShieldCheckIcon },
  { key: 'privacy', icon: DatabaseIcon },
];

/**
 * `/{locale}/settings` — the list of settings pages: Profile and Preferences (P2-07), Sessions and
 * security (P2-08), Your data — export and account deletion (P2-10, `/settings/privacy`);
 * notifications and the rest are added by the features that own them
 * (ARCHITECTURE §7). Static: no user data in the server HTML (ADR-0020).
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
        {PAGES.map(({ key, icon: Icon }) => (
          <li key={key}>
            <Link
              href={`/settings/${key}`}
              className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4 outline-none hover:bg-surface-secondary focus-visible:ring-[3px] focus-visible:ring-accent/50"
            >
              <Icon aria-hidden="true" className="size-6 shrink-0 text-text-secondary" />
              <span className="flex grow flex-col gap-1">
                <span className="font-medium text-text-primary">{t(`${key}.title`)}</span>
                <span className="text-sm text-text-secondary">{t(`${key}.summary`)}</span>
              </span>
              <ChevronRightIcon
                aria-hidden="true"
                className="size-5 shrink-0 text-text-secondary rtl:-scale-x-100"
              />
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-sm text-text-secondary">{t('more')}</p>
    </div>
  );
}
