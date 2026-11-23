# @habit/web

Next.js 16 App Router frontend. Phase 0 contains only a bilingual shell:

- `/en` (LTR) and `/fa` (RTL) routes; `<html lang dir>` derived from `lib/i18n/config.ts`
- JSON dictionaries in `lib/i18n/dictionaries/` (a test enforces identical keys)
- Tailwind CSS v4 wired to design tokens from `@habit/ui/tokens.css`

Use logical CSS properties/utilities (`ms-*`, `pe-*`, `start-*`, `text-start`) — never physical
left/right — so layouts mirror correctly in RTL. Fonts (Inter, Vazirmatn) are self-hosted in Phase 1.
