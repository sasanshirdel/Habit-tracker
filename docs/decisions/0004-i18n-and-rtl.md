# ADR-0004: Internationalisation and RTL/LTR approach

- **Status:** Accepted — Phase 0 stub, implemented with next-intl in Phase 1 (P1-10, 2026-11-25)
- **Date:** 2026-11-24 (updated 2026-11-25)

## Context

PRD §3.12: Persian (RTL) and English (LTR) are both first-class; Persian must not be a superficial translation layer. Dates, numbers, currency, validation messages, notifications and emails must be localised; all UI text comes from dictionaries.

## Decision

- **Locale in the URL path:** `/{locale}/...` with `locale ∈ {en, fa}` (`apps/web/app/[locale]`). Unknown locales 404 (`dynamicParams = false`). Path locales are cacheable, shareable and SEO-friendly.
- **Direction is derived, never hand-set:** `getDirection(locale)` sets `<html lang dir>` in the locale layout. Components use **logical** CSS (Tailwind `ms-/me-/ps-/pe-/start-/end-/text-start`) — physical `left/right` utilities are disallowed in review (lint rule planned).
- **Dictionaries:** JSON per locale; a test enforces identical key sets so a missing translation fails CI.
- **Formatting:** `Intl` with `fa-IR` / `en-US` (`getIntlLocale`). Persian digits verified by test. Calendar choice (Solar Hijri vs Gregorian display) is a user preference to be designed in Phase 1/2 — storage is always UTC instants + IANA timezone (ADR-0006).
- **Library:** Phase 0 uses a ~30-line stub to avoid an unverified dependency. **Phase 1 adopts `next-intl`** (4.16.0 checked; supports Next 16 and React 19) for message formatting (ICU plurals), locale negotiation (Accept-Language / cookie → redirect), and server/client message loading — subject to re-verification at install time.
- **Fonts:** Inter (Latin) and Vazirmatn (Persian), self-hosted in Phase 1 (no runtime Google Fonts fetch). Token: `--font-latin`, `--font-persian`.
- **Backend:** API returns error **codes** + params, not English prose; the web layer localises. Emails/notifications are templated per locale (Phase 8).
- **Default locale:** `en` in the stub — **open decision for the owner** (see ROADMAP "Outstanding decisions").

## Consequences

- Every UI PR must be checked in both `/en` and `/fa` (Definition of Done).
- Bidirectional user content (mixed Persian/English habit names) needs `dir="auto"` on user-generated text; covered in Phase 1 design-system work.

## Phase 1 implementation (P1-10, 2026-11-25)

- **Library:** `next-intl` **4.16.0** (re-verified at install; ADR-0001 addendum). Not 4.16.1, which was
  under pnpm's minimum release age.
- **Routing** (`apps/web/lib/i18n/routing.ts`): `localePrefix: 'always'` — every page keeps its
  `/{locale}` prefix. A request without one (`/`, `/pricing`) gets a **307** to the negotiated
  locale: the `NEXT_LOCALE` cookie (an explicit choice; set by the language switcher or by visiting
  a locale the browser does not prefer — `SameSite=Lax`, 1 year, `Secure` in production, not
  `HttpOnly` because the client-side switcher updates it), then `Accept-Language`, then
  `defaultLocale`. The redirect changes only the path, never the host (next-intl sanitises
  `//host`, `\host` and encoded variants; covered by unit and route tests) and carries
  `Vary: Accept-Language, Cookie`. Unsupported values in the cookie or header are ignored.
- **Default locale:** still the one constant `defaultLocale` in `@habit/localization` — **interim
  `en`**, open owner decision (ROADMAP "Outstanding decisions" #1). Changing that constant changes
  `/` negotiation's fallback and every consumer at once.
- **Proxy composition:** `apps/web/proxy.ts` remains the single Next.js proxy. It builds the
  per-request nonce CSP (ADR-0011) first and hands next-intl a request that already carries the
  nonce and CSP headers; next-intl forwards request headers on pass-through, so Next.js still finds
  the nonce while rendering. Locale routing applies to `GET`/`HEAD` page paths only (no file
  extensions, no `/_next/`); everything else still gets the CSP.
- **Messages:** ICU messages in `apps/web/lib/i18n/messages/{en,fa}.json` (UI strings stay in the web
  app; `@habit/localization` holds only what web and api share). English is the reference type for
  `t()` keys (`global.d.ts`), so an unknown key is a compile error. CI fails when the catalogues
  differ in keys, when a value is empty, when a message's ICU arguments differ between locales, or
  when any message fails to parse/format; a missing message throws in tests instead of falling back.
- **Formatting** (`apps/web/lib/i18n/formats.ts`): named date/number/list formats shared by messages
  and `format.*()`. Persian gets Persian digits and separators (`۱٬۲۳۴`, `۴۲٪`) through `Intl`.
  Dates follow CLDR's locale default calendar — Solar Hijri for `fa`, Gregorian for `en` — as an
  **interim** choice until decision #8; it is one `calendar` option in `formats.ts`. Time zone is
  `UTC` on server and client until users have a profile zone (Phase 2).
- **Direction guard:** the shared ESLint config rejects physical left/right Tailwind utilities in
  `className`/`class` and in `cn()`/`clsx()`/`cva()`/`twMerge()` arguments (`ml-*`, `pr-*`,
  `left-*`, `text-right`, `border-l`, `rounded-tr-*`, …); a test scans the web and UI stylesheets
  for physical `margin/padding/border/inset-left|right`, `left:`/`right:`, `text-align/float: left|right`.
- **404s:** `app/[locale]/[...rest]` sends unknown paths under a locale to the localized
  `[locale]/not-found.tsx`. Known Next.js 16.4 limitation (vercel/next.js#99793, #100596): a
  render-time `notFound()` is drawn by the browser from the RSC payload (with the locale layout's
  `lang`/`dir`), while the server HTML is Next's `__next_error__` shell (404, `noindex`). The route
  test documents this and switches to the strict check when upstream fixes it.
- **Testing:** Playwright arrives with P1-13; until then `apps/web/e2e` runs HTTP route tests
  against `next start` in CI (`lang`/`dir`, redirects, cookie, nonce on every script).

## Application shell (P1-11, 2026-11-25)

- **Navigation mirrors by layout, not by code:** the sidebar sits at the inline start (right in
  RTL) and the bottom bar starts with Overview at the inline start, through flex order and logical
  borders only — no per-direction branches.
- **Icons:** flip an icon in RTL (`rtl:-scale-x-100`) only when it shows direction or reading order
  — arrows, chevrons, a list with leading markers (the Tasks icon). Objects, clocks, checkmarks,
  sparkles and charts used as symbols are not flipped. Per section this is the `mirrorInRtl` flag in
  `apps/web/lib/navigation/sections.ts` (tested).
- **Language switcher:** keeps the current page (`/fa/habits` ⇄ `/en/habits`) and marks the link
  with `hreflang`/`lang` of its target.
