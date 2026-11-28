/**
 * "Which local date is it?" — the one place the engine meets clocks and time zones (ADR-0029).
 *
 * Everything else in the engine works on local dates only, so DST and zone changes cannot move a
 * scheduled day. Turning an instant into the user's local date needs the IANA time-zone database,
 * which only `Intl` has; that is deterministic for a given tz-data release (Node 24 ships its
 * own). The engine never reads the current time: callers pass the instant (`new Date()` at the
 * edge, a fixed instant in tests).
 */
import { ScheduleInputError } from './errors.js';

/** Formatter cache: building an `Intl.DateTimeFormat` is far slower than using one. */
const formatters = new Map<string, Intl.DateTimeFormat>();
const FORMATTER_CACHE_MAX = 64;

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new ScheduleInputError('INVALID_TIME_ZONE', 'timeZone must be an IANA time zone');
  }
  if (formatters.size >= FORMATTER_CACHE_MAX) formatters.clear();
  formatters.set(timeZone, formatter);
  return formatter;
}

/** True when `Intl` knows `timeZone` (IANA names such as `Asia/Tehran`; `UTC`). */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The local date (`YYYY-MM-DD`, Gregorian) at `instant` in `timeZone` — e.g. "today" for a user
 * from `new Date()` and their profile zone. `instant` is a `Date`, epoch milliseconds or an ISO
 * 8601 string **with** an offset or `Z` (a zone-less string would be read in the server's zone).
 */
export function localDateAt(instant: Date | number | string, timeZone: string): string {
  let ms: number;
  if (instant instanceof Date) ms = instant.getTime();
  else if (typeof instant === 'number') ms = instant;
  else if (typeof instant === 'string' && /(Z|[+-]\d{2}:\d{2})$/i.test(instant))
    ms = Date.parse(instant);
  else ms = Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new ScheduleInputError(
      'INVALID_INSTANT',
      'instant must be a valid Date, epoch ms or ISO string with offset',
    );
  }
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) values[part.type] = part.value;
  return `${String(values.year).padStart(4, '0')}-${String(values.month)}-${String(values.day)}`;
}
