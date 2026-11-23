# ADR-0004: Internationalisation and RTL/LTR approach

- **Status:** Accepted (Phase 0 stub; full implementation Phase 1)
- **Date:** 2026-11-24

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
