import { useId } from 'react';
import type * as React from 'react';
import { cn } from '../lib/cn.js';

export interface EmptyStateProps extends Omit<React.ComponentProps<'section'>, 'title'> {
  /** Decorative icon (an SVG element); hidden from assistive technology. */
  icon?: React.ReactNode;
  /** Localized heading of the empty state. */
  title: React.ReactNode;
  /** Localized explanation of what will appear here. */
  description?: React.ReactNode;
  /** Optional call to action, e.g. a `<Button>`. */
  action?: React.ReactNode;
  /** Heading level of `title` — keep the page outline intact (default `h2`). */
  headingLevel?: 2 | 3 | 4;
}

/**
 * Empty state (P1-11): a labelled region with an icon, a heading, a description and an optional
 * action, for lists and sections that have nothing to show yet. Centered on both axes, so it reads
 * the same in RTL and LTR; every string is a prop the app fills from its messages.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  headingLevel = 2,
  className,
  ...props
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  const titleId = useId();
  return (
    <section
      data-slot="empty-state"
      aria-labelledby={titleId}
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full bg-surface-secondary text-accent [&_svg]:size-6"
        >
          {icon}
        </div>
      ) : null}
      <Heading id={titleId} className="text-lg font-semibold text-text-primary">
        {title}
      </Heading>
      {description ? <p className="max-w-prose text-text-secondary">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}
