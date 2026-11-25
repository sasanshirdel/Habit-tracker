import type * as React from 'react';
import { cn } from '../lib/cn.js';

/**
 * Loading placeholder (P1-09). Decorative: hidden from assistive technology — announce loading
 * on the container instead (`aria-busy="true"`). The pulse stops under `prefers-reduced-motion`.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-surface-secondary', className)}
      {...props}
    />
  );
}
