'use client';

import {
  DISPLAY_NAME_MAX_LENGTH,
  profileUpdateSchema,
  type ProfileUpdate,
} from '@habit/shared-validation';
import { Alert, Button, Input, Label, Skeleton, toast } from '@habit/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { QueryError } from '@/components/status/query-error';
import { useProfile, useUpdateProfile } from '@/lib/account/preferences';
import { useErrorMessage } from '@/lib/api/error-messages';
import { schemaResolver } from '@/lib/forms/schema-resolver';

type ProfileFields = { displayName: string };

/**
 * Settings → Profile (backlog P2-07, ADR-0024): the display name. Validated with the shared
 * `profileUpdateSchema` (the API's own rule: NFKC, single spaces, ≤ 100 characters, no control or
 * bidi-override characters; blank removes the name) for immediate feedback; the API decides.
 * Rendered only below `AuthGate`. Avatar upload is a later follow-up (object storage).
 */
export function ProfileSettings() {
  const t = useTranslations('settings.profile');
  const profile = useProfile();

  if (profile.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (profile.isError) {
    return <QueryError error={profile.error} onRetry={() => void profile.refetch()} />;
  }
  return <ProfileForm initial={profile.data.displayName ?? ''} />;
}

function ProfileForm({ initial }: { initial: string }) {
  const t = useTranslations('settings.profile');
  const errorMessage = useErrorMessage();
  const update = useUpdateProfile();
  const id = useId();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<ProfileFields, unknown, ProfileUpdate>({
    resolver: schemaResolver<ProfileFields, ProfileUpdate>(profileUpdateSchema),
    defaultValues: { displayName: initial },
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  useEffect(() => reset({ displayName: initial }), [initial, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const saved = await update.mutateAsync({ displayName: values.displayName });
      // Show what the server stored (normalised), and make that the new clean state.
      reset({ displayName: saved.displayName ?? '' });
      toast({ title: t('saved'), variant: 'success' });
    } catch (error) {
      setFormError(errorMessage(error));
    }
  });

  const fieldError = errors.displayName
    ? errors.displayName.type === 'too_big'
      ? t('tooLong', { max: DISPLAY_NAME_MAX_LENGTH })
      : t('invalidCharacters')
    : undefined;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <form
      noValidate
      onSubmit={(event) => (isSubmitting ? event.preventDefault() : void onSubmit(event))}
      aria-busy={isSubmitting}
      className="flex max-w-xl flex-col gap-5"
      data-profile-form=""
    >
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{t('displayName')}</Label>
        <Input
          id={id}
          dir="auto"
          autoComplete="name"
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${errorId} ${hintId}` : hintId}
          {...register('displayName')}
        />
        <p id={hintId} className="text-sm text-text-secondary">
          {t('displayNameHint', { max: DISPLAY_NAME_MAX_LENGTH })}
        </p>
        {fieldError ? (
          <p id={errorId} data-slot="field-error" className="text-sm text-danger">
            {fieldError}
          </p>
        ) : null}
      </div>
      <Button
        type="submit"
        className="self-start"
        aria-disabled={isSubmitting || undefined}
        disabled={!isDirty && !isSubmitting}
      >
        {isSubmitting ? t('saving') : t('save')}
      </Button>
    </form>
  );
}
