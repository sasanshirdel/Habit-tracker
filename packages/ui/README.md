# @habit/ui

The design system (backlog P1-09, [ADR-0013](../../docs/decisions/0013-design-system.md)).

- **Tokens** — `src/tokens.ts` (source of truth) mirrored in `tokens.css`; a test keeps them in
  sync, and `contrast.test.ts` checks WCAG 2.2 AA for every text token on every surface in both
  themes. Use them through Tailwind (`bg-surface`, `text-text-secondary`, `text-accent`,
  `border-border-strong`, `bg-danger`, …) — never raw colours.
- **Styles** — in a Tailwind v4 app: `@import 'tailwindcss'; @import '@habit/ui/styles.css';`
  (tokens, Tailwind theme mapping, `tw-animate-css`, focus ring, reduced motion, and `@source` for
  the primitives' classes).
- **Themes** — `dark` (default), `light`, `system`. `THEME_COOKIE`, `parseThemePreference()`,
  `themeCookie()`; the server renders `<html data-theme>` from the cookie (no flash).
- **Primitives** (shadcn/ui `new-york-v4` adapted, Radix underneath): `Button` (`asChild` for links),
  `Input`, `Skeleton`, `Dialog*`, `DropdownMenu*`, `Toaster` + `toast()`. Logical CSS only; labels
  such as a dialog's `closeLabel` or the toaster's `label`/`regionLabel`/`closeLabel` are props —
  pass localized messages.
- **`UiProvider`** — wrap the app once with `dir` (Radix direction) and the request's CSP `nonce`
  (for the `<style>` the modal scroll lock injects).

Consumed through `dist/` (`pnpm build:packages`). Tests: `pnpm --filter @habit/ui test` (tokens,
contrast, theme cookie, and component tests in jsdom with Testing Library, in LTR and RTL).
