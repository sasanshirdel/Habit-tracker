# @habit/localization

Locale metadata shared by `apps/web` and `apps/api` (ADR-0004): supported `locales` (`en`, `fa`),
`defaultLocale`, `isLocale`, `getDirection` (`fa` → `rtl`, `en` → `ltr`) and `getIntlLocale`
(`fa-IR` / `en-US`, so Persian gets Persian digits). UI message dictionaries stay in `apps/web`
(next-intl, P1-10). Consumed through `dist/` — run `pnpm build:packages` first.
