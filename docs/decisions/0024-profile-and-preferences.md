# ADR-0024: Profile and preferences

- **Status:** Accepted (P2-07, avatar deferred)
- **Date:** 2026-11-27

## Context

Backlog P2-07 (#27): profile editing and the preferences used across the app — language, IANA time
zone, theme and calendar display (PRD §3.11 "Profile editing, Avatar, Language preference,
Timezone, Theme preference"; §3.12 localized dates; §2.2 theme switching). ADR-0017 created
`user_profiles` (display name) and `user_preferences` (locale, timezone, theme) without routes.
ROADMAP "Outstanding decisions" #8 asked whether Persian users see Solar Hijri dates. The weekly
matrix (Phase 3) needs a first day of the week. Avatar upload needs object storage, whose provider
depends on the unresolved hosting decision (ROADMAP #3).

## Decision

### Scope

Display name and five preferences now. **Avatar upload is deferred** to a follow-up of #27 (the
issue stays open): it needs a storage provider, a private bucket, signed URLs and file sniffing,
none of which can be chosen before ROADMAP #3. No column for it is added yet.

### Data (migration `20261127120000_profile_preferences`, additive)

- New enums `calendar_system` (`gregorian`, `solar_hijri`) and `week_start` (`saturday`,
  `sunday`, `monday`); new columns `user_preferences.calendar` (default `gregorian`) and
  `week_start` (default `monday`) — constant defaults, no table rewrite.
- **Backfill:** existing rows with `locale = 'fa'` get `solar_hijri` / `saturday`, matching what
  registration now writes (`defaultDisplayPreferencesFor(locale)` in shared-validation:
  fa → Solar Hijri + Saturday, en → Gregorian + Monday). Tested from the previous release's
  schema (`profile.int.test.ts`) plus the generic upgrade/drift test.
- The calendar is a **display** preference only: the API keeps speaking UTC instants and ISO
  (Gregorian) `YYYY-MM-DD` local dates (ADR-0006); habit days are computed in the time zone.

### Validation (`@habit/shared-validation`, used by API and web forms)

- **Display name** (`displayNameSchema`): raw input ≤ 1024 UTF-16 units, then NFKC, whitespace
  runs collapsed to one space, trimmed; ≤ 100 code points (`user_profiles_display_name_check`);
  blank or `null` → `null` (removes the name). Rejected: C0/C1 control characters (line breaks,
  tabs) and bidi embedding/override/isolate controls U+202A–202E, U+2066–2069 (spoofing in lists).
  ZWNJ/ZWJ stay allowed (Persian spelling). Registration uses the same schema, so a blank display
  name at sign-up now means "none" instead of a 400.
- **Preferences** (`preferencesSchema`, `preferencesUpdateSchema`): locale `en|fa`; time zone via
  the existing `timeZoneSchema` (IANA Region/City or UTC, checked against the runtime's ICU data;
  offsets/abbreviations rejected); theme `dark|light|system`; calendar; week start. The update is
  a strict, non-empty partial — unknown fields (e.g. `userId`) are a 400.

### API (`ProfileController` in the identity module)

- `GET /account/profile` → `{ displayName }`; `PATCH /account/profile` `{ displayName }` → stored
  profile (upsert).
- `GET /account/preferences` → all five; `PATCH /account/preferences` any subset → all five.
- Protected by the global guard (session required; CSRF on `PATCH`), rate-limit class `default`
  per user, always the caller's own row (no id in the URL), standard error envelope
  (`VALIDATION_FAILED`, `UNAUTHENTICATED`, `CSRF_FAILED`, `NOT_FOUND` if a preference row is
  missing), documented in OpenAPI (tag `Profile`, components `UserProfile`, `UserPreferences`).
- **No security event:** none of these fields protects the account (email and password changes,
  which do, are separate features and must add events per ADR-0023). Changes are not logged;
  `displayName`, `fullName`, `firstName`, `lastName` became redacted log keys.

### Web

- Pages `/{locale}/settings/profile` and `/{locale}/settings/preferences` (ARCHITECTURE §7), linked
  from `/settings`; static server frame, data loaded below `AuthGate` (ADR-0020). Forms use
  react-hook-form + `schemaResolver` over the shared schemas; errors are localized from issue
  codes; only changed preferences are sent.
- New `@habit/ui` primitive `NativeSelect` (native `<select>`: OS pickers, type-ahead, no ARIA to
  get wrong; ~400 time zones from `Intl.supportedValuesOf('timeZone')`, shown left-to-right).
- **Locale:** saving a new language calls next-intl's `router.replace(pathname, { locale })`, so the
  page moves to `/fa/…` or `/en/…` (and `NEXT_LOCALE` remembers it for `/`). The header language
  switcher still only switches the view in this browser (it does not change the stored
  preference) — see open decision 2.
- **Theme:** saved → applied at once on `<html data-theme>` and written to the `theme` cookie, so
  the server renders it from the first byte afterwards (P1-09, no inline script). The app shell's
  theme switcher follows the account preference and saves a choice made there. **Limit:** in a
  browser whose cookie differs from the account (a new device), the first app page renders the
  cookie's theme and switches once `GET /account/preferences` answers — the web server cannot read
  the API's host-only session cookie (ADR-0019/0020), so this flash cannot be removed until the API
  is served under the web origin (ROADMAP #11).
- **Dates:** `useDateDisplay()` returns the profile time zone and `Intl` calendar (`gregory` |
  `persian`); the security page's dates use it. Fallback while loading: browser zone and the page
  locale's default calendar.

## Alternatives considered

- **Calendar derived from the locale only** (status quo since P1-10) — Persian speakers outside
  Iran often use Gregorian dates, and English speakers in Iran Solar Hijri; a separate preference
  is cheap. Rejected.
- **Nullable calendar/week start meaning "follow the language"** — avoids the backfill, but every
  reader then needs the fallback rule and the stored value stops saying what the user sees.
  Rejected.
- **A combobox/listbox component (Radix Select or cmdk) for time zones** — searchable, but a new
  dependency or a large custom widget with ARIA risk; the native select is accessible and
  type-ahead works on IANA names. Revisit if users struggle.
- **Strip control characters silently** instead of rejecting — hides surprising changes to what
  the user typed; a clear error is better for a name.
- **Single `/account/settings` resource** — profile (public-facing) and preferences (private
  behaviour) have different future fields (avatar, privacy); two resources match ARCHITECTURE §7.

## Open decisions (interim choices, reversible; for the owner)

1. **Defaults** for new accounts: fa → Solar Hijri + Saturday, en → Gregorian + Monday (resolves
   ROADMAP #8 as interim). Should en default to Sunday?
2. **Header language switcher**: view-only (current) or also saving the preference when signed in?
   And should sign-in move the user to their stored language (one redirect after login)?
3. **Avatar**: storage provider/bucket with ROADMAP #3; then size/type limits, sniffing, signed
   URL lifetime, moderation.

## Consequences

- Phase 3 reads `weekStart` and `timezone` for the weekly matrix; every date shown to a signed-in
  user should go through `useDateDisplay` (or the same two options).
- Avatar work owes: a storage ADR, a nullable column/table for the object key, upload + signed-URL
  routes, and the settings UI.
- Emails still use the account locale only; formatting dates in emails with the user's calendar is
  for the notification work (Phase 8).
