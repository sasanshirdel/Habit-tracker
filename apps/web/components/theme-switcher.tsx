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
  themeCookie,
  themePreferences,
  type ThemePreference,
} from '@habit/ui';
import { MoonIcon, MonitorIcon, SunIcon } from 'lucide-react';
import { useState } from 'react';

const icons = { dark: MoonIcon, light: SunIcon, system: MonitorIcon } as const;

export interface ThemeSwitcherProps {
  /** The preference the server rendered with (from the theme cookie). */
  initial: ThemePreference;
  labels: Record<'label' | ThemePreference, string>;
}

/**
 * Theme menu (backlog P1-09). Applies the choice at once on `<html data-theme>` and stores it in
 * the `theme` cookie, which the server reads on the next request — so there is never a flash.
 */
export function ThemeSwitcher({ initial, labels }: ThemeSwitcherProps) {
  const [theme, setTheme] = useState<ThemePreference>(initial);
  const Icon = icons[theme];

  function choose(value: string) {
    if (!isThemePreference(value)) return;
    setTheme(value);
    document.documentElement.dataset.theme = value;
    document.cookie = themeCookie(value, window.location.protocol === 'https:');
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
