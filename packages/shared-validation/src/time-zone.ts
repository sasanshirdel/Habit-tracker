import { z } from 'zod';

// Region/City style IANA names ("Asia/Tehran", "America/Argentina/Buenos_Aires", "Etc/GMT+3")
// or the UTC aliases. Offset strings ("+03:30") and abbreviations ("IRST") are rejected on
// purpose: they do not carry DST rules, and habit occurrences are computed in the user's zone.
const IANA_SHAPE = /^(?:UTC|Etc\/UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/** True when the runtime's ICU data knows `value` as a time zone. */
function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * An IANA time zone identifier, as stored with every user (ADR-0006: UTC instants + user IANA
 * zone). Validity is checked against the runtime's ICU time-zone data, so web and api agree
 * as long as both run current Node/browsers.
 */
export const timeZoneSchema = z
  .string()
  .max(64)
  .refine((v) => IANA_SHAPE.test(v) && isKnownTimeZone(v), {
    message: 'Must be an IANA time zone such as "Asia/Tehran" or "UTC"',
  });
