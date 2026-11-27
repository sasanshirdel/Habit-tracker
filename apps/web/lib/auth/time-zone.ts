import { timeZoneSchema } from '@habit/shared-validation';

/**
 * The browser's IANA time zone for a new account (P2-09), validated with the API's own schema;
 * `UTC` when the browser reports none or one the API would reject. Editable later in settings
 * (P2-07).
 */
export function browserTimeZone(): string {
  let zone: string | undefined;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    zone = undefined;
  }
  return zone && timeZoneSchema.safeParse(zone).success ? zone : 'UTC';
}
