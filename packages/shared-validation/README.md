# @habit/shared-validation

zod 4 schemas that are the single source of input rules for web forms and API DTOs. The server
always validates again — frontend checks are UX only.

| Schema            | Accepts                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `localeSchema`    | `en` \| `fa` (from `@habit/localization`)                                                             |
| `timeZoneSchema`  | IANA zone names known to the runtime's ICU data (`Asia/Tehran`, `UTC`); rejects offsets/abbreviations |
| `localDateSchema` | Real Gregorian calendar dates `YYYY-MM-DD` (habit occurrences are keyed by local date, ADR-0006)      |

Validation messages are developer-facing; the UI maps failures to localised strings. Consumed
through `dist/` — run `pnpm build:packages` first.
