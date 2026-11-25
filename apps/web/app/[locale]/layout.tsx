import '@fontsource-variable/inter';
import '@fontsource-variable/vazirmatn';
import { THEME_COOKIE, Toaster, UiProvider, parseThemePreference } from '@habit/ui';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { getDirection, locales, parseLocale } from '@/lib/i18n/config';
import '../globals.css';

export const dynamicParams = false;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const locale = parseLocale((await params).locale);
  if (!locale) return {};
  const t = await getTranslations({ locale, namespace: 'meta' });
  return { title: t('title'), description: t('description') };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  // Render per request: the CSP nonce (proxy.ts, P1-08) only reaches Next's scripts in a dynamic
  // render; a prerendered page would carry no nonce and its scripts would be blocked.
  await connection();
  const locale = parseLocale((await params).locale);
  if (!locale) notFound();
  // The `[locale]` segment is the source of truth for this render (P1-10, ADR-0004).
  setRequestLocale(locale);

  const [cookieStore, headerStore, t] = await Promise.all([
    cookies(),
    headers(),
    getTranslations('toast'),
  ]);
  // Theme from the cookie, rendered on the first byte: no flash, no inline script (P1-09).
  const theme = parseThemePreference(cookieStore.get(THEME_COOKIE)?.value);
  const nonce = headerStore.get('x-nonce') ?? undefined;
  const dir = getDirection(locale);

  return (
    <html lang={locale} dir={dir} data-theme={theme}>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider>
          <UiProvider dir={dir} nonce={nonce}>
            {children}
            <Toaster label={t('label')} regionLabel={t('region')} closeLabel={t('close')} />
          </UiProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
