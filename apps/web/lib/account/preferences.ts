'use client';

import {
  defaultCalendarFor,
  getIntlCalendar,
  type CalendarSystem,
  type IntlCalendar,
} from '@habit/localization';
import type {
  UpdatePreferencesRequest,
  UpdateProfileRequest,
  UserPreferences,
  UserProfile,
} from '@habit/shared-types';
import { themeCookie, type ThemePreference } from '@habit/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { useMemo } from 'react';
import { api } from '@/lib/api/api';
import type { Locale } from '@/lib/i18n/config';

/**
 * The signed-in user's profile and preferences (backlog P2-07, ADR-0024): `GET`/`PATCH
 * /account/profile` and `/account/preferences`. UX only — the API scopes both to the session's
 * user and validates every value with the same shared schemas.
 */

export const profileQueryKey = ['account', 'profile'] as const;
export const preferencesQueryKey = ['account', 'preferences'] as const;

export function useProfile() {
  return useQuery({
    queryKey: profileQueryKey,
    queryFn: ({ signal }) => api.get<UserProfile>('/account/profile', { signal }),
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) => api.patch<UserProfile>('/account/profile', body),
    onSuccess: (profile) => queryClient.setQueryData(profileQueryKey, profile),
  });
}

/** Preferences change rarely and only here, so a loaded copy stays fresh for the page's life. */
export function usePreferences({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: preferencesQueryKey,
    queryFn: ({ signal }) => api.get<UserPreferences>('/account/preferences', { signal }),
    staleTime: Infinity,
    enabled,
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdatePreferencesRequest) =>
      api.patch<UserPreferences>('/account/preferences', body),
    onSuccess: (preferences) => queryClient.setQueryData(preferencesQueryKey, preferences),
  });
}

/**
 * Applies a theme in this browser at once (`<html data-theme>`) and stores it in the `theme`
 * cookie, which the server reads on the next request — so pages render in it from the first byte
 * (P1-09: no flash, no inline script).
 */
export function applyTheme(theme: ThemePreference): void {
  document.documentElement.dataset.theme = theme;
  document.cookie = themeCookie(theme, window.location.protocol === 'https:');
}

export interface DateDisplay {
  /** IANA zone dates and times are shown in. */
  timeZone: string;
  /** `Intl` calendar (`gregory` | `persian`). */
  calendar: IntlCalendar;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * How to show dates to the signed-in user: their profile time zone and calendar (P2-07). Until the
 * preferences have loaded (or if they fail to), the browser's zone and the page locale's default
 * calendar. Pass the result into `format.dateTime(date, { …, ...display })`. Use only below
 * `AuthGate` (it reads `GET /account/preferences`).
 */
export function useDateDisplay(): DateDisplay {
  const locale = useLocale() as Locale;
  const preferences = usePreferences();
  const timezone = preferences.data?.timezone;
  const calendar: CalendarSystem = preferences.data?.calendar ?? defaultCalendarFor(locale);
  return useMemo(
    () => ({ timeZone: timezone ?? browserZone(), calendar: getIntlCalendar(calendar) }),
    [timezone, calendar],
  );
}
