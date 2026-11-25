'use client';

import { XIcon } from 'lucide-react';
import { Direction, Toast as ToastPrimitive } from 'radix-ui';
import { useSyncExternalStore } from 'react';
import { cn } from '../lib/cn.js';

/**
 * Toasts on Radix Toast (P1-09). Radix rather than shadcn's default (sonner): sonner injects a
 * `<style>` element without a nonce at import time, which the production CSP blocks. Radix
 * announces toasts in a polite live region and supports swipe-to-dismiss toward the inline end.
 *
 * Render one `<Toaster>` (inside `UiProvider`) with localized labels; call `toast()` anywhere on
 * the client.
 */
export type ToastVariant = 'default' | 'success' | 'error';

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastItem extends Required<Pick<ToastInput, 'title' | 'variant'>> {
  id: number;
  description?: string;
}

const MAX_VISIBLE = 3;
const EMPTY: readonly ToastItem[] = [];
let items: readonly ToastItem[] = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: readonly ToastItem[]) {
  items = next;
  for (const listener of listeners) listener();
}

/** Shows a toast; returns its id. Only the newest three stay on screen. */
export function toast({ title, description, variant = 'default' }: ToastInput): number {
  const id = nextId++;
  const item: ToastItem =
    description === undefined ? { id, title, variant } : { id, title, description, variant };
  emit([...items, item].slice(-MAX_VISIBLE));
  return id;
}

export function dismissToast(id: number): void {
  emit(items.filter((item) => item.id !== id));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const variantClasses: Record<ToastVariant, string> = {
  default: 'border-border',
  success: 'border-accent',
  error: 'border-danger',
};

export interface ToasterProps {
  /** Announced with each toast by screen readers ("Notification"). */
  label: string;
  /** Accessible name of the toast region ("Notifications"). */
  regionLabel: string;
  /** Accessible name of each toast's close button. */
  closeLabel: string;
  /** Milliseconds before a toast closes (Radix pauses it while hovered or focused). */
  duration?: number;
}

export function Toaster({ label, regionLabel, closeLabel, duration = 5000 }: ToasterProps) {
  const toasts = useSyncExternalStore(
    subscribe,
    () => items,
    () => EMPTY,
  );
  const dir = Direction.useDirection();

  return (
    <ToastPrimitive.Provider
      label={label}
      duration={duration}
      swipeDirection={dir === 'rtl' ? 'left' : 'right'}
    >
      {toasts.map((item) => (
        <ToastPrimitive.Root
          key={item.id}
          data-slot="toast"
          data-variant={item.variant}
          // Errors interrupt (assertive); everything else waits its turn (polite).
          type={item.variant === 'error' ? 'foreground' : 'background'}
          onOpenChange={(open) => {
            if (!open) dismissToast(item.id);
          }}
          className={cn(
            'group relative flex w-full items-start gap-3 rounded-md border bg-surface-elevated p-4 pe-12 text-text-primary shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[swipe=end]:animate-out',
            variantClasses[item.variant],
          )}
        >
          <div className="grid gap-1">
            <ToastPrimitive.Title className="text-sm font-semibold">
              {item.title}
            </ToastPrimitive.Title>
            {item.description ? (
              <ToastPrimitive.Description className="text-sm text-text-secondary">
                {item.description}
              </ToastPrimitive.Description>
            ) : null}
          </div>
          <ToastPrimitive.Close
            aria-label={closeLabel}
            className="absolute end-2 top-2 inline-flex size-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-[3px] focus-visible:ring-accent/50 focus-visible:outline-none"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport
        label={regionLabel}
        className="fixed bottom-0 end-0 z-[100] m-0 flex max-h-screen w-full list-none flex-col gap-2 p-4 outline-none sm:max-w-sm"
      />
    </ToastPrimitive.Provider>
  );
}
