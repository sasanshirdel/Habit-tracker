import { CircleAlertIcon, CircleCheckIcon, InfoIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../lib/cn.js';

export type AlertTone = 'danger' | 'success' | 'info';

export interface AlertProps extends React.ComponentProps<'div'> {
  tone?: AlertTone;
}

const icons = { danger: CircleAlertIcon, success: CircleCheckIcon, info: InfoIcon };

/**
 * Inline message for a form or a page (P2-09): an error (`role="alert"`, announced at once), or a
 * success/info note (`role="status"`, announced politely). Keep it mounted only while it applies,
 * so a new message is announced when it appears. Content is a localized string from the app.
 */
export function Alert({ tone = 'info', className, children, ...props }: AlertProps) {
  const Icon = icons[tone];
  return (
    <div
      data-slot="alert"
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border bg-surface p-3 text-sm text-text-primary',
        tone === 'danger' && 'border-danger/60',
        tone === 'success' && 'border-accent/60',
        tone === 'info' && 'border-border-strong',
        className,
      )}
      {...props}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'danger'
            ? 'text-danger'
            : tone === 'success'
              ? 'text-accent'
              : 'text-text-secondary',
        )}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
