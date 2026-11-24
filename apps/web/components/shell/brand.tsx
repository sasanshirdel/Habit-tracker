import { cn } from '@habit/ui';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/lib/i18n/navigation';
import { appHomeHref } from '@/lib/navigation/sections';

/** The product name, linking to the app's home (P1-11). The short label is hidden on the rail. */
export async function Brand({ className }: { className?: string }) {
  const t = await getTranslations('shell');
  return (
    <Link
      href={appHomeHref}
      aria-label={t('home')}
      className={cn(
        'flex min-h-10 items-center gap-2 rounded-md font-semibold text-text-primary focus-visible:ring-[3px] focus-visible:ring-accent/50 focus-visible:outline-none',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-sm text-accent-foreground"
      >
        {t('brand').slice(0, 1)}
      </span>
      <span className="md:max-lg:sr-only">{t('brand')}</span>
    </Link>
  );
}
