import { getTranslations } from 'next-intl/server';
import { VerifyEmail } from '@/components/auth/verify-email';
import { AuthHeading, authMetadata, resolveAuthPage, type AuthPageProps } from '../auth-page';

export const generateMetadata = authMetadata('verifyEmail');

/**
 * `/{locale}/auth/verify-email#token=…` — opened from the verification email (backlog P2-04,
 * ADR-0021). The server never sees the token (URL fragment); the client component reads it and
 * asks the user to confirm.
 */
export default async function VerifyEmailPage(props: AuthPageProps) {
  await resolveAuthPage(props);
  const t = await getTranslations('auth.verifyEmail');
  return (
    <>
      <AuthHeading title={t('title')} description={t('description')} />
      <VerifyEmail />
    </>
  );
}
