import { getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { AuthHeading, authMetadata, resolveAuthPage, type AuthPageProps } from '../auth-page';

export const generateMetadata = authMetadata('forgotPassword');

/** `/{locale}/auth/forgot-password` — ask for a password-reset link (backlog P2-05, ADR-0022). */
export default async function ForgotPasswordPage(props: AuthPageProps) {
  await resolveAuthPage(props);
  const t = await getTranslations('auth.forgotPassword');
  return (
    <>
      <AuthHeading title={t('title')} description={t('description')} />
      <ForgotPasswordForm />
    </>
  );
}
