# @habit/web

Next.js 16 App Router frontend, bilingual from the first page:

- **i18n with next-intl** (P1-10, ADR-0004): `/en` (LTR) and `/fa` (RTL); `<html lang dir>` comes
  from the `[locale]` segment. `/` and other unprefixed paths redirect (307) to the negotiated
  locale — `NEXT_LOCALE` cookie, then `Accept-Language`, then `defaultLocale` from
  `@habit/localization` (interim `en`, open owner decision).
  - `lib/i18n/routing.ts` — locales, prefix, cookie; `lib/i18n/request.ts` — per-request locale,
    messages, formats, time zone; `lib/i18n/navigation.ts` — locale-aware `Link`, `redirect`,
    `useRouter` (use these, not `next/link`, for internal links).
  - `lib/i18n/messages/{en,fa}.json` — ICU messages. Keys are typed from `en.json`
    (`global.d.ts`); a test fails on missing/extra keys, empty values, mismatched ICU arguments or
    unparsable messages.
  - `lib/i18n/formats.ts` — named date/number formats (`{date, date, long}`, `format.number(x,
'percent')`). Persian gets Persian digits; dates use the locale's default calendar (Solar
    Hijri for `fa`) for now.
  - Unknown paths under a locale render the localized `app/[locale]/not-found.tsx`.
- **Design system** (P1-09, ADR-0013): Tailwind CSS v4 + `@habit/ui/styles.css` (tokens, themes,
  primitives). The locale layout renders `<html data-theme>` from the `theme` cookie (dark default,
  light, system — no flash), wraps the app in `UiProvider` (direction + CSP nonce) and mounts the
  localized `Toaster`. `components/theme-switcher.tsx` sets the cookie. Fonts are self-hosted from
  `@fontsource-variable/inter` and `@fontsource-variable/vazirmatn` (served from `/_next/static/media`).
- Security headers (P1-08, ADR-0011): `proxy.ts` sets a per-request nonce Content-Security-Policy
  and then runs next-intl's locale routing with the nonce already on the request, so Next.js adds
  the nonce to its scripts on every page (pages render dynamically — the locale layout calls
  `connection()`). `next.config.ts` adds static headers (HSTS, `nosniff`, frame/referrer/
  permissions policies) from `lib/security/headers.ts`. Never add inline `<script>`; use
  `next/script` with the nonce from the `x-nonce` request header.

- **Application shell** (P1-11, ARCHITECTURE §7): pages in the `app/[locale]/(app)` route group
  (no URL segment) render inside `components/shell/app-shell.tsx`:
  - skip link (first focusable) → `main#main`; `RouteFocus` moves focus to `main` after every
    client-side navigation;
  - `SidebarNav` (`md`: icon rail, `lg`: full sidebar) at the inline start, `MobileNav` (below `md`:
    bottom bar + "More" bottom sheet on the `Dialog` primitive), both labelled `navigation`
    landmarks; the current section has `aria-current="page"`;
  - a `banner` with the brand (phones), `LanguageSwitcher` (same page, other locale) and the theme
    switcher.
  - Sections, their order, their mobile slot and whether their icon flips in RTL live in
    `lib/navigation/sections.ts`; labels are `nav.*` messages, placeholder copy `sections.*`.
  - Each section page is a placeholder (`components/shell/section-page.tsx`: heading +
    `EmptyState`), `noindex`. **No authorization yet** — P2-03 adds the session check to
    `app/[locale]/(app)/layout.tsx`. Overview is at `/{locale}/overview` (interim, see ROADMAP
    decision #10).

- **Data layer** (P1-12, ADR-0014): `lib/api/client.ts` (`createApiClient`; the app's instance is
  `lib/api/api.ts`, base URL `NEXT_PUBLIC_API_BASE_URL`), `lib/api/errors.ts` (`ApiError`, client
  codes), `lib/api/query-client.ts` (TanStack Query defaults, `QueryProvider` in the locale layout),
  `lib/api/error-messages.ts` (`useErrorMessage()` → `apiErrors.<CODE>`), `lib/api/queries/*`
  (`queryOptions` per resource). Standard error state: `components/status/query-error.tsx`. Demo:
  `/{locale}/status` (API liveness/readiness from the browser). Every API error code needs an
  `apiErrors` message in both catalogues (test). Cookies only — never put tokens in web storage.

Use logical CSS properties/utilities (`ms-*`, `pe-*`, `start-*`, `text-start`) — never physical
left/right; ESLint rejects physical utilities in class names and a test scans the stylesheets.
No raw colour values outside the tokens (`lib/design-guard.test.ts`).

## Tests

```bash
pnpm --filter @habit/web test        # unit + component (jsdom): messages parity, formatting, proxy routing, CSP, shell
pnpm --filter @habit/web build
pnpm --filter @habit/web test:e2e    # HTTP route tests against `next start` (lang/dir, redirects, nonce, shell)
```

### Browser tests (Playwright, P1-13, ADR-0015)

`e2e/browser/*.spec.ts` drive headless Chromium against the production build under `next start`
(`127.0.0.1:3100`) and the built API (`127.0.0.1:4100`, `NODE_ENV=production`) on PostgreSQL and
Redis — Playwright starts both (`playwright.config.ts`), or reuses ones already running locally.
Covered: `<html lang dir>` and the computed direction, locale negotiation and the switcher; the
shell at phone/tablet/desktop in `fa` and `en` (bottom bar / icon rail / sidebar, inline start,
no horizontal overflow); the keyboard journey (skip link, "More" sheet focus trap, Escape, focus
after navigation); CSP enforcement (injected inline script and handler blocked, foreign
`connect-src` refused, menus and the sheet stay inside the policy); `/status` calling the API
cross-origin. Every test also fails on any CSP violation, `console.error` or uncaught error.

```bash
# PostgreSQL + Redis running, migrations applied (pnpm --filter @habit/api db:migrate:deploy)
export DATABASE_URL=postgresql://… REDIS_URL=redis://127.0.0.1:6379
pnpm build:deps                                                # the API the suite starts
pnpm --filter @habit/web exec playwright install --only-shell chromium   # once per Playwright version
pnpm --filter @habit/web build:e2e                             # web build pointing at the suite's API
pnpm --filter @habit/web test:browser                          # report: playwright-report/, traces: test-results/
```

`build:e2e` bakes `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4100/api/v1` into the bundle; the
route tests (`test:e2e`) pass on that build too. Behind an HTTP proxy, set
`NO_PROXY=127.0.0.1,localhost`.
