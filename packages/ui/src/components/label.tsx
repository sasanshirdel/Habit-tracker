import type * as React from 'react';
import { cn } from '../lib/cn.js';

/**
 * Form label (P2-09). A plain `<label>`: pass `htmlFor` with the control's id, so clicking the
 * label focuses the control and assistive technology announces it as the control's name.
 */
export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('text-sm font-medium text-text-primary', className)}
      {...props}
    />
  );
}
