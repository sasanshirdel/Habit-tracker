import { getTranslations } from 'next-intl/server';
import { SignInForm } from '@/components/auth/sign-in-form';
import { AuthHeading, authMetadata, resolveAuthPage, type AuthPageProps } from '../auth-page';

export const generateMetadata = authMetadata('signIn');

export default async function SignInPage(props: AuthPageProps) {
  const { next } = await resolveAuthPage(props);
  const t = await getTranslations('auth.signIn');
  return (
    <>
      <AuthHeading title={t('title')} description={t('description')} />
      <SignInForm next={next} />
    </>
  );
}
