'use client';

import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { useState } from 'react';
import type * as React from 'react';
import { cn } from '../lib/cn.js';
import { Input } from './input.js';

export interface PasswordInputProps extends Omit<React.ComponentProps<'input'>, 'type'> {
  /**
   * Localized accessible name of the visibility toggle, e.g. "Show password". The button is a
   * toggle (`aria-pressed`), so the name stays the same and the pressed state says whether the
   * password is visible.
   */
  toggleLabel: string;
}

/**
 * Password field with a show/hide toggle (P2-09). Pass `autoComplete` (`current-password` or
 * `new-password`) so password managers fill and save correctly. The field stays left-to-right in
 * Persian pages too (passwords are not prose), with the toggle at the end of the text (the right),
 * inside the field. Showing the password never changes its value, its autocomplete or its focus.
 */
export function PasswordInput({
  toggleLabel,
  className,
  id,
  disabled,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    // The whole control is left-to-right, so the toggle stays at the end of the text (its right)
    // in Persian pages too, and the padding reserved for it is on the same side.
    <div data-slot="password-input" dir="ltr" className="relative">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        dir="ltr"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        className={cn('pe-12 text-start', className)}
        {...props}
      />
      <button
        type="button"
        aria-label={toggleLabel}
        aria-pressed={visible}
        aria-controls={id}
        disabled={disabled}
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-e-md text-text-secondary outline-none hover:text-text-primary focus-visible:ring-[3px] focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50"
      >
        {visible ? (
          <EyeOffIcon aria-hidden="true" className="size-5" />
        ) : (
          <EyeIcon aria-hidden="true" className="size-5" />
        )}
      </button>
    </div>
  );
}
