# @habit/web

Next.js 16 App Router frontend. Phase 0 contains only a bilingual shell:

- `/en` (LTR) and `/fa` (RTL) routes; `<html lang dir>` derived from `lib/i18n/config.ts`
- JSON dictionaries in `lib/i18n/dictionaries/` (a test enforces identical keys)
- Tailwind CSS v4 wired to design tokens from `@habit/ui/tokens.css`
- Security headers (P1-08, ADR-0011): `proxy.ts` sets a per-request nonce Content-Security-Policy
  (Next.js adds the nonce to its scripts; pages therefore render dynamically — the locale layout
  calls `connection()`), and `next.config.ts` adds static headers (HSTS, `nosniff`, frame/referrer/
  permissions policies) from `lib/security/headers.ts`. Never add inline `<script>`; use
  `next/script` with the nonce from the `x-nonce` request header.

Use logical CSS properties/utilities (`ms-*`, `pe-*`, `start-*`, `text-start`) — never physical
left/right — so layouts mirror correctly in RTL. Fonts (Inter, Vazirmatn) are self-hosted in Phase 1.
