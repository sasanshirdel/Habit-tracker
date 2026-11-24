# ADR-0013: Design system — shadcn/ui primitives on Radix, themes, fonts

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

PRD §2.2 asks for a premium dark-first UI with a light theme, centralised colour tokens, Inter for
English and Vazirmatn for Persian, full RTL/LTR, accessible contrast, touch-friendly controls and
consistent loading/error states. The architecture puts shared primitives in `packages/ui`
(shadcn/ui-based). Constraints from earlier decisions: logical CSS only (ADR-0004), a strict nonce
CSP on every page (ADR-0011: scripts and `<style>` elements need the request's nonce), pinned and
release-age-checked dependencies (ADR-0001). Backlog P1-09 (#13).

## Decision

- **Primitives in `packages/ui`**, written from the shadcn/ui registry sources (`new-york-v4` style,
  shadcn CLI 4.23.0 checked on 2026-11-25) and adapted rather than generated into the app: Button,
  Input, Skeleton, Dialog, DropdownMenu and Toast, plus `cn()`. Adaptations: Habit tokens instead
  of shadcn's palette variables; logical utilities only (dialog centred with `inset-x-0 mx-auto`,
  close buttons at `end-*`, menu indicators at `start-*`, sub-menu chevron flipped in RTL); every
  built-in English string is a prop (`closeLabel`, toast labels) so the app passes messages;
  `type="button"` by default; ≥ 40 px icon buttons. The package is built with `tsc` to `dist/` like
  the other packages (ADR-0002 addendum); client components keep their `'use client'` directive.
- **Radix through the `radix-ui` 1.8.1 package**, the same headless library shadcn uses.
  `UiProvider` (once, in the locale layout) supplies the text direction to Radix
  (`Direction.Provider`) and passes the CSP nonce to `get-nonce`, which the modal scroll lock
  (`react-remove-scroll` → `react-style-singleton`) reads for the `<style>` element it injects.
- **Toasts on Radix Toast, not sonner** (shadcn's default): sonner 2.0.8 injects a `<style>` element
  without a nonce at import time, which the production CSP blocks. Radix Toast injects nothing,
  announces in a polite live region (errors assertive) and swipes toward the inline end.
- **Tokens** (`tokens.ts` = source of truth, mirrored in `tokens.css`, sync-tested). New tokens:
  `accent-foreground`, `danger`, `danger-foreground`, and `border-strong` for control boundaries
  (≥ 3:1, WCAG 1.4.11); `border` stays a decorative separator. **Light `accent` is `#8A6420`, not the
  PRD's suggested `#A9802C`**: that value reaches only ~3.4:1 on the light background and fails AA
  for text; `#8A6420` keeps the hue and reaches ≥ 4.5:1 on every light surface. A test asserts AA
  (4.5:1) for every text token on every surface in both themes, text on accent/danger fills, and 3:1
  for `border-strong` and the accent focus ring. `styles.css` maps the tokens into Tailwind v4
  (`bg-surface`, `text-accent`, `border-border-strong`, …), adds `tw-animate-css` and makes Tailwind
  scan the package's sources.
- **Themes:** `dark` (default), `light`, `system`. The choice is a `theme` cookie (`SameSite=Lax`, one
  year, `Secure` on HTTPS, not `HttpOnly` — the switcher writes it); the server renders
  `<html data-theme>` from it, so the first paint is right with no inline script. `system` is
  resolved in CSS with `prefers-color-scheme`. Unknown cookie values fall back to dark. Phase 2 moves
  the preference into the user profile (PRD §5 preferences); the cookie remains the anonymous
  fallback.
- **Fonts self-hosted** from `@fontsource-variable/inter` and `@fontsource-variable/vazirmatn` 5.3.0
  (OFL-1.1), imported in the locale layout. Next.js bundles the `woff2` files under
  `/_next/static/media` (same origin, `font-src 'self'`); every subset has a `unicode-range`, so a page
  downloads only the scripts it uses; `font-display: swap`. Persian pages use Vazirmatn (which also
  covers Latin), English pages Inter.
- **Guards:** a web test fails on raw colour values (`#hex`, `rgb()`, `hsl()`, `oklch()`) anywhere in
  the web app or the UI package except the token files; the P1-10 lint rule already rejects
  physical left/right utilities.

## Alternatives considered

- **Running `shadcn init`/`add` in `apps/web`**: generates components into the app with shadcn's
  palette variables and physical classes; we would rewrite them anyway, and a shared package is what
  the architecture and the future admin app (`apps/admin`) need.
- **sonner** for toasts: CSP conflict above.
- **`next-themes`** (shadcn's theme helper): resolves the theme on the client with an inline script,
  which needs a CSP exception; the cookie + server render needs no dependency and no flash.
- **`next/font/google`**: downloads from Google at build time (a build-time dependency on a host
  that may be unreachable from Iranian infrastructure); `next/font/local` would need the files
  vendored. Fontsource packages are pinned, verifiable and subset by `unicode-range`.
- **Keeping `#A9802C`** for light accent text: fails WCAG AA; using it only for non-text decoration
  would split the accent into two tokens without a design need yet.

## Consequences

- Every primitive renders from tokens and mirrors in RTL; new primitives follow the same rules
  (logical utilities, labels as props, tokens only) and get component tests (jsdom, Testing Library).
- The PRD's light accent differs from the suggestion; the owner can revisit it — the contrast test
  shows the trade-off.
- `UiProvider` must wrap the app for RTL behaviour in Radix and for the scroll-lock nonce.
- Browser-level checks (visual, real CSP enforcement of injected styles) arrive with Playwright in
  P1-13; jsdom tests verify that the injected style carries the nonce.

## Addendum — P1-11 application shell (2026-11-25)

- **`EmptyState`** joins the primitives: a region named by its heading (`aria-labelledby`), a
  decorative icon, a description and an optional action; heading level configurable (default
  `h2`) so pages keep their outline. Not from the shadcn registry (its `empty` block is
  presentational only); written here with tokens and centred layout, so it needs no RTL variant.
- **Bottom sheet = `DialogContent` restyled** (`top-auto bottom-0 translate-y-0`, slide from the
  bottom) rather than a new Drawer/vaul dependency: the shell's "More" sheet keeps Radix Dialog's
  focus trap, Escape, scroll lock (nonce-aware) and focus return. When a sheet link navigates away,
  focus return is cancelled and the shell focuses the new page's `main` instead.
