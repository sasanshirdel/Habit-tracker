import { cn } from '@habit/ui';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/lib/i18n/navigation';
import { appHomeHref } from '@/lib/navigation/sections';

/**
 * The product name, linking to the app's home (P1-11) — or to `href` (the auth pages link to the
 * landing page). The short label is hidden on the rail.
 */
export async function Brand({
  className,
  href = appHomeHref,
  rail = true,
}: {
  className?: string;
  href?: string;
  /** Inside the shell's navigation: hide the name on the tablet icon rail. */
  rail?: boolean;
}) {
  const t = await getTranslations('shell');
  return (
    <Link
      href={href}
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
      <span className={rail ? 'md:max-lg:sr-only' : undefined}>{t('brand')}</span>
    </Link>
  );
}
