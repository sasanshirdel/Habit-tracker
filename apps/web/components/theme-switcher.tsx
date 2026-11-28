'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  isThemePreference,
  themePreferences,
  type ThemePreference,
} from '@habit/ui';
import type { UserPreferences } from '@habit/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { MoonIcon, MonitorIcon, SunIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  applyTheme,
  preferencesQueryKey,
  usePreferences,
  useUpdatePreferences,
} from '@/lib/account/preferences';
import { useSession } from '@/lib/auth/session';

const icons = { dark: MoonIcon, light: SunIcon, system: MonitorIcon } as const;

export interface ThemeSwitcherProps {
  /** The preference the server rendered with (from the theme cookie). */
  initial: ThemePreference;
  labels: Record<'label' | ThemePreference, string>;
  /**
   * In the signed-in app shell (P2-07): follow the account's theme preference and save a choice
   * made here to it. Off on public pages, which must not ask the API who is signed in.
   */
  syncWithAccount?: boolean;
}

/**
 * Theme menu (backlog P1-09). Applies the choice at once on `<html data-theme>` and stores it in
 * the `theme` cookie, which the server reads on the next request — so there is never a flash.
 *
 * With `syncWithAccount` (P2-07, ADR-0024) the account preference is the source of truth: once it
 * has loaded, a different cookie value is replaced by it (a browser that has not seen the account
 * before shows the cookie's theme for that first page — the server cannot read the API's session,
 * ADR-0020), and a choice made here is also saved to the account.
 */
export function ThemeSwitcher({ initial, labels, syncWithAccount = false }: ThemeSwitcherProps) {
  const [chosen, setChosen] = useState<ThemePreference>(initial);
  const queryClient = useQueryClient();
  const session = useSession({ enabled: syncWithAccount });
  const signedIn = syncWithAccount && session.data?.status === 'signed-in';
  const preferences = usePreferences({ enabled: signedIn });
  const update = useUpdatePreferences();
  const accountTheme = signedIn ? preferences.data?.theme : undefined;
  // Signed in, the account's preference (kept current optimistically below) is what is shown.
  const theme = accountTheme ?? chosen;
  const Icon = icons[theme];

  // Brings the document (an external system) in line with the account preference.
  useEffect(() => {
    if (accountTheme && document.documentElement.dataset.theme !== accountTheme) {
      applyTheme(accountTheme);
    }
  }, [accountTheme]);

  function choose(value: string) {
    if (!isThemePreference(value)) return;
    setChosen(value);
    applyTheme(value);
    if (!signedIn || value === accountTheme) return;
    queryClient.setQueryData<UserPreferences>(preferencesQueryKey, (old) =>
      old ? { ...old, theme: value } : old,
    );
    // On failure, show what the account really holds again.
    update.mutate(
      { theme: value },
      { onError: () => void queryClient.invalidateQueries({ queryKey: preferencesQueryKey }) },
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={`${labels.label}: ${labels[theme]}`}>
          <Icon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{labels.label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={choose}>
          {themePreferences.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {labels[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
