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
- Tailwind CSS v4 wired to design tokens from `@habit/ui/tokens.css`.
- Security headers (P1-08, ADR-0011): `proxy.ts` sets a per-request nonce Content-Security-Policy
  and then runs next-intl's locale routing with the nonce already on the request, so Next.js adds
  the nonce to its scripts on every page (pages render dynamically — the locale layout calls
  `connection()`). `next.config.ts` adds static headers (HSTS, `nosniff`, frame/referrer/
  permissions policies) from `lib/security/headers.ts`. Never add inline `<script>`; use
  `next/script` with the nonce from the `x-nonce` request header.

Use logical CSS properties/utilities (`ms-*`, `pe-*`, `start-*`, `text-start`) — never physical
left/right; ESLint rejects physical utilities in class names and a test scans the stylesheets.
Fonts (Inter, Vazirmatn) are self-hosted with the design system (P1-09).

## Tests

```bash
pnpm --filter @habit/web test        # unit: messages parity, formatting, proxy routing, CSP
pnpm --filter @habit/web build
pnpm --filter @habit/web test:e2e    # HTTP route tests against `next start` (lang/dir, redirects, nonce)
```
