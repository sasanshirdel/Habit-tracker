'use client';

import { setNonce } from 'get-nonce';
import { Direction } from 'radix-ui';
import type { ReactNode } from 'react';

export interface UiProviderProps {
  /** Text direction of the page (`rtl` for Persian); Radix primitives read it. */
  dir: 'ltr' | 'rtl';
  /**
   * This request's CSP nonce. Modal primitives (Dialog, DropdownMenu) lock page scroll with a
   * `<style>` element (react-remove-scroll); with the nonce it passes the strict `style-src` CSP
   * (ADR-0011, P1-08). The nonce is already public in the page's script tags.
   */
  nonce?: string | undefined;
  children: ReactNode;
}

/** Wrap the app once, in the locale layout (backlog P1-09). */
export function UiProvider({ dir, nonce, children }: UiProviderProps) {
  // Before any primitive mounts (children render after this). Idempotent per request.
  if (nonce) setNonce(nonce);
  return <Direction.Provider dir={dir}>{children}</Direction.Provider>;
}
