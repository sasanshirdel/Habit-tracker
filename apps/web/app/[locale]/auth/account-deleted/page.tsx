import { ACCOUNT_DELETION_GRACE_DAYS } from '@habit/shared-types';
import { Button } from '@habit/ui';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/lib/i18n/navigation';
import { AuthHeading, authMetadata, resolveAuthPage, type AuthPageProps } from '../auth-page';

export const generateMetadata = authMetadata('accountDeleted');

/**
 * `/{locale}/auth/account-deleted` — where the app goes right after the user deleted their account
 * (backlog P2-10, ADR-0025). Static: it holds no user data (the session is already gone) and only
 * explains the grace period and the emailed restore link.
 */
export default async function AccountDeletedPage(props: AuthPageProps) {
  await resolveAuthPage(props);
  const t = await getTranslations('auth.accountDeleted');
  return (
    <>
      <AuthHeading title={t('title')} description={t('description')} />
      <div className="flex flex-col gap-5" data-account-deleted="">
        <p className="text-text-secondary">{t('body', { days: ACCOUNT_DELETION_GRACE_DAYS })}</p>
        <Button asChild size="lg" variant="outline">
          <Link href="/">{t('home')}</Link>
        </Button>
      </div>
    </>
  );
}
