/**
 * Web-side locale configuration. Locale metadata (supported locales, direction, Intl tags) is
 * shared with the API through `@habit/localization`; route params are validated with the
 * shared `localeSchema` (`@habit/shared-validation`) so web and api accept exactly the same
 * values. Phase 1 replaces the dictionary loader with next-intl (P1-10, ADR-0004).
 */
import { type Locale } from '@habit/localization';
import { localeSchema } from '@habit/shared-validation';

export {
  defaultLocale,
  getDirection,
  getIntlLocale,
  isLocale,
  locales,
  type Direction,
  type Locale,
} from '@habit/localization';

/** Validates a `[locale]` route segment; `null` means "not a supported locale" (→ 404). */
export function parseLocale(segment: string): Locale | null {
  const result = localeSchema.safeParse(segment);
  return result.success ? result.data : null;
}
