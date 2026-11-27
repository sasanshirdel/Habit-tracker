import { getTranslations } from 'next-intl/server';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { AuthHeading, authMetadata, resolveAuthPage, type AuthPageProps } from '../auth-page';

export const generateMetadata = authMetadata('resetPassword');

/**
 * `/{locale}/auth/reset-password#token=…` — opened from the password-reset email (backlog P2-05,
 * ADR-0022). The server never sees the token (URL fragment); the client component reads it and
 * asks for the new password.
 */
export default async function ResetPasswordPage(props: AuthPageProps) {
  await resolveAuthPage(props);
  const t = await getTranslations('auth.resetPassword');
  return (
    <>
      <AuthHeading title={t('title')} description={t('description')} />
      <ResetPasswordForm />
    </>
  );
}
