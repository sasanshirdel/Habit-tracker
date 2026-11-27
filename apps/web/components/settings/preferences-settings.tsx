'use client';

import { calendarSystems, locales, weekStarts } from '@habit/localization';
import type { UpdatePreferencesRequest, UserPreferences } from '@habit/shared-types';
import { preferencesSchema, type PreferencesInput } from '@habit/shared-validation';
import { Alert, Button, Label, NativeSelect, Skeleton, themePreferences, toast } from '@habit/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { QueryError } from '@/components/status/query-error';
import { applyTheme, usePreferences, useUpdatePreferences } from '@/lib/account/preferences';
import { useErrorMessage } from '@/lib/api/error-messages';
import { schemaResolver } from '@/lib/forms/schema-resolver';
import { usePathname, useRouter } from '@/lib/i18n/navigation';

type PreferenceFields = UserPreferences;
type PreferenceKey = keyof UserPreferences;
const FIELDS: readonly PreferenceKey[] = ['locale', 'timezone', 'theme', 'calendar', 'weekStart'];

/** Language names in their own language, as language pickers conventionally show them. */
const NATIVE_LANGUAGE_NAMES = { en: 'English', fa: 'فارسی' } as const;

/**
 * Every IANA zone the browser knows (≈ 400), plus `UTC` and the saved value, sorted. The API checks
 * the choice against its own ICU data, so an exotic browser list cannot store anything invalid.
 */
function timeZoneOptions(current: string): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  return [...new Set([...zones, 'UTC', current])].sort();
}

/**
 * Settings → Preferences (backlog P2-07, ADR-0024): language, time zone, theme, calendar and week
 * start, validated with the shared `preferencesSchema`. Only changed fields are sent. After a save
 * the theme applies at once (and in the `theme` cookie, so the next page renders in it); a new
 * language switches this page to its locale route. Rendered only below `AuthGate`.
 */
export function PreferencesSettings() {
  const t = useTranslations('settings.preferences');
  const preferences = usePreferences();

  if (preferences.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (preferences.isError) {
    return <QueryError error={preferences.error} onRetry={() => void preferences.refetch()} />;
  }
  return <PreferencesForm saved={preferences.data} />;
}

function PreferencesForm({ saved }: { saved: UserPreferences }) {
  const t = useTranslations('settings.preferences');
  const tTheme = useTranslations('theme');
  const errorMessage = useErrorMessage();
  const update = useUpdatePreferences();
  const router = useRouter();
  const pathname = usePathname();
  const [formError, setFormError] = useState<string | null>(null);
  const zones = useMemo(() => timeZoneOptions(saved.timezone), [saved.timezone]);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<PreferenceFields, unknown, PreferencesInput>({
    resolver: schemaResolver<PreferenceFields, PreferencesInput>(preferencesSchema),
    defaultValues: saved,
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  useEffect(() => reset(saved), [saved, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const changes: UpdatePreferencesRequest = {};
    for (const key of FIELDS) {
      if (values[key] !== saved[key]) Object.assign(changes, { [key]: values[key] });
    }
    if (Object.keys(changes).length === 0) return;
    try {
      const stored = await update.mutateAsync(changes);
      if (changes.theme) applyTheme(stored.theme);
      if (changes.locale) {
        // The new language is the new route: /en/settings/preferences ⇄ /fa/… (also sets
        // NEXT_LOCALE, so `/` opens in it). The page re-renders in that language.
        router.replace(pathname, { locale: stored.locale });
        return;
      }
      toast({ title: t('saved'), variant: 'success' });
    } catch (error) {
      setFormError(errorMessage(error));
    }
  });

  return (
    <form
      noValidate
      onSubmit={(event) => (isSubmitting ? event.preventDefault() : void onSubmit(event))}
      aria-busy={isSubmitting}
      className="flex max-w-xl flex-col gap-6"
      data-preferences-form=""
    >
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <SelectField
        label={t('language')}
        hint={t('languageHint')}
        registration={register('locale')}
        error={errors.locale ? t('invalidChoice') : undefined}
        name="locale"
      >
        {locales.map((value) => (
          <option key={value} value={value} lang={value}>
            {NATIVE_LANGUAGE_NAMES[value]}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('timeZone')}
        hint={t('timeZoneHint')}
        registration={register('timezone')}
        error={errors.timezone ? t('invalidTimeZone') : undefined}
        name="timezone"
        ltr
      >
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone.replaceAll('_', ' ')}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('calendar')}
        hint={t('calendarHint')}
        registration={register('calendar')}
        error={errors.calendar ? t('invalidChoice') : undefined}
        name="calendar"
      >
        {calendarSystems.map((value) => (
          <option key={value} value={value}>
            {t(`calendars.${value}`)}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('weekStart')}
        registration={register('weekStart')}
        error={errors.weekStart ? t('invalidChoice') : undefined}
        name="weekStart"
      >
        {weekStarts.map((value) => (
          <option key={value} value={value}>
            {t(`weekdays.${value}`)}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={tTheme('label')}
        registration={register('theme')}
        error={errors.theme ? t('invalidChoice') : undefined}
        name="theme"
      >
        {themePreferences.map((value) => (
          <option key={value} value={value}>
            {tTheme(value)}
          </option>
        ))}
      </SelectField>
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

function SelectField({
  label,
  hint,
  error,
  registration,
  name,
  ltr,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  registration: UseFormRegisterReturn;
  /** For tests and the browser suite: `data-preference="<field>"`. */
  name: PreferenceKey;
  /** IANA names are Latin identifiers: keep them left-to-right inside Persian pages. */
  ltr?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error && errorId, hint && hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-2" data-preference={name}>
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        dir={ltr ? 'ltr' : undefined}
        className={ltr ? 'text-start' : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...registration}
      >
        {children}
      </NativeSelect>
      {hint ? (
        <p id={hintId} className="text-sm text-text-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} data-slot="field-error" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
