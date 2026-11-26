import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { NEXT_PARAM, safeNextPath } from '@/lib/auth/redirect';
import { parseLocale, type Locale } from '@/lib/i18n/config';

export type AuthPageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `<title>` of an auth page: "Sign in · Habit Tracker". The verification page (P2-04) is never
 * indexed: it only makes sense with a personal link.
 */
export function authMetadata(page: 'signIn' | 'signUp' | 'verifyEmail') {
  return async function generateMetadata({ params }: AuthPageProps): Promise<Metadata> {
    const locale = parseLocale((await params).locale);
    if (!locale) return {};
    const [t, tMeta] = await Promise.all([
      getTranslations({ locale, namespace: `auth.${page}` }),
      getTranslations({ locale, namespace: 'meta' }),
    ]);
    return {
      title: `${t('title')} · ${tMeta('title')}`,
      ...(page === 'verifyEmail' ? { robots: { index: false, follow: false } } : {}),
    };
  };
}

/** Validates the locale and reads the `next` parameter — already sanitised (open-redirect guard). */
export async function resolveAuthPage({
  params,
  searchParams,
}: AuthPageProps): Promise<{ locale: Locale; next: string | null }> {
  const locale = parseLocale((await params).locale);
  if (!locale) notFound();
  setRequestLocale(locale);
  const raw = (await searchParams)[NEXT_PARAM];
  return { locale, next: safeNextPath(typeof raw === 'string' ? raw : null) };
}

export function AuthHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}): ReactNode {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <h1 className="text-2xl font-semibold text-text-primary">{title}</h1>
      <p className="text-text-secondary">{description}</p>
    </div>
  );
}
