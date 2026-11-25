# @habit/localization

Locale metadata shared by `apps/web` and `apps/api` (ADR-0004): supported `locales` (`en`, `fa`),
`defaultLocale`, `isLocale`, `getDirection` (`fa` → `rtl`, `en` → `ltr`) and `getIntlLocale`
(`fa-IR` / `en-US`, so Persian gets Persian digits). `defaultLocale` (interim `en`, open owner
decision) is the one place to change the default: the web app's next-intl routing and negotiation
use it. UI messages stay in `apps/web/lib/i18n/messages` (next-intl, P1-10). Consumed through `dist/` — run `pnpm build:packages` first.
