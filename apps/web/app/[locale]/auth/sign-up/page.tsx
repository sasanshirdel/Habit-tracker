import { getTranslations } from 'next-intl/server';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { AuthHeading, authMetadata, resolveAuthPage, type AuthPageProps } from '../auth-page';

export const generateMetadata = authMetadata('signUp');

export default async function SignUpPage(props: AuthPageProps) {
  const { next } = await resolveAuthPage(props);
  const t = await getTranslations('auth.signUp');
  return (
    <>
      <AuthHeading title={t('title')} description={t('description')} />
      <SignUpForm next={next} />
    </>
  );
}
