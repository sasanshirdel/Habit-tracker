import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { getDirection, locales, parseLocale } from '@/lib/i18n/config';
import { getDictionary } from '@/lib/i18n/dictionaries';
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
  const t = getDictionary(locale);
  return { title: t.meta.title, description: t.meta.description };
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

  return (
    <html lang={locale} dir={getDirection(locale)} data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
