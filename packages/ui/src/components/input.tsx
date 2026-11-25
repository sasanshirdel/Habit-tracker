import type * as React from 'react';
import { cn } from '../lib/cn.js';

/**
 * Text input (shadcn/ui, adapted; P1-09). The border uses `border-strong` (≥ 3:1, WCAG 1.4.11);
 * `aria-invalid` switches it to `danger`. Use `dir="auto"` for user-generated text that can mix
 * Persian and English (habit names, notes).
 */
export function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-10 w-full min-w-0 rounded-md border border-border-strong bg-transparent px-3 py-1 text-base text-text-primary transition-[color,box-shadow] outline-none placeholder:text-text-secondary disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:ring-[3px] focus-visible:ring-accent/50',
        'aria-invalid:border-danger aria-invalid:ring-danger/20',
        className,
      )}
      {...props}
    />
  );
}
