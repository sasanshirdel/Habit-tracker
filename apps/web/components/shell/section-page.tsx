import { EmptyState } from '@habit/ui';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { parseLocale } from '@/lib/i18n/config';
import type { SectionKey } from '@/lib/navigation/sections';
import { sectionIcons } from './section-icons';

type PageProps = { params: Promise<{ locale: string }> };

/**
 * Placeholder page for a primary section (backlog P1-11): its localized heading and an empty
 * state saying what will live there. Each feature replaces its page in its own phase.
 */
export function sectionPage(key: SectionKey) {
  async function SectionPage({ params }: PageProps) {
    const locale = parseLocale((await params).locale);
    if (!locale) notFound();
    setRequestLocale(locale);
    const [tNav, t] = await Promise.all([getTranslations('nav'), getTranslations('sections')]);
    const Icon = sectionIcons[key];
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold text-text-primary md:text-3xl">{tNav(key)}</h1>
        <EmptyState
          data-section={key}
          icon={<Icon />}
          title={t(`${key}.emptyTitle`)}
          description={t(`${key}.emptyDescription`)}
        />
      </div>
    );
  }
  SectionPage.displayName = `SectionPage(${key})`;
  return SectionPage;
}

/** `<title>`: "Habits · Habit Tracker" / "عادت‌ها · ردیاب عادت". */
export function sectionMetadata(key: SectionKey) {
  return async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const locale = parseLocale((await params).locale);
    if (!locale) return {};
    const [tNav, tMeta] = await Promise.all([
      getTranslations({ locale, namespace: 'nav' }),
      getTranslations({ locale, namespace: 'meta' }),
    ]);
    return { title: `${tNav(key)} · ${tMeta('title')}` };
  };
}
