import { ChevronDownIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../lib/cn.js';

/**
 * Native `<select>` styled like {@link Input} (backlog P2-07). The browser's own picker is the
 * most accessible choice for plain option lists — keyboard type-ahead, the OS picker on phones,
 * screen-reader support with no ARIA to get wrong — and long lists (≈ 400 time zones) cost no
 * JavaScript. The chevron sits at the inline end, so it flips in RTL. Options are children; their
 * text comes from the app's messages.
 */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <div data-slot="native-select" className="relative w-full min-w-0">
      <select
        className={cn(
          'h-10 w-full min-w-0 appearance-none rounded-md border border-border-strong bg-transparent ps-3 pe-9 py-1 text-base text-text-primary transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          'focus-visible:ring-[3px] focus-visible:ring-accent/50',
          'aria-invalid:border-danger aria-invalid:ring-danger/20',
          // The open list uses the page's surface colours (dark theme included).
          '[&>option]:bg-surface [&>option]:text-text-primary',
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
      />
    </div>
  );
}
