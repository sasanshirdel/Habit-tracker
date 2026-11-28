import { getTranslations } from 'next-intl/server';
import { RestoreAccount } from '@/components/auth/restore-account';
import { AuthHeading, authMetadata, resolveAuthPage, type AuthPageProps } from '../auth-page';

export const generateMetadata = authMetadata('restoreAccount');

/**
 * `/{locale}/auth/restore-account#token=…` — opened from the "account deleted" email (backlog
 * P2-10, ADR-0025). The server never sees the token (URL fragment); the client component reads it
 * and asks the user to confirm.
 */
export default async function RestoreAccountPage(props: AuthPageProps) {
  await resolveAuthPage(props);
  const t = await getTranslations('auth.restoreAccount');
  return (
    <>
      <AuthHeading title={t('title')} description={t('description')} />
      <RestoreAccount />
    </>
  );
}
