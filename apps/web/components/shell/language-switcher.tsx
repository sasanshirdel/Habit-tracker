'use client';

import { Button } from '@habit/ui';
import { LanguagesIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '@/lib/i18n/navigation';

/**
 * Switches to the other locale on the same page (P1-11): `/fa/habits` ⇄ `/en/habits`. next-intl's
 * `Link locale=…` also stores the choice in the `NEXT_LOCALE` cookie, so `/` remembers it.
 */
export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations('language');
  const pathname = usePathname();
  const other = locale === 'fa' ? 'en' : 'fa';

  return (
    <Button asChild variant="ghost" size="sm">
      <Link href={pathname} locale={other} hrefLang={other} lang={other}>
        <LanguagesIcon aria-hidden="true" />
        {t('switchTo')}
      </Link>
    </Button>
  );
}
