/**
 * Per-request next-intl configuration (backlog P1-10), wired in through the next-intl plugin in
 * `next.config.ts`. Server components read their locale, messages and formats from here.
 */
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_TIME_ZONE, formats } from './formats';
import { messages } from './messages';
import { routing } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  // `requestLocale` is the `[locale]` segment (via `setRequestLocale`) or the locale the proxy
  // resolved for this request. Anything else falls back to the default — it is never trusted.
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return {
    locale,
    messages: messages[locale],
    formats,
    timeZone: DEFAULT_TIME_ZONE,
  };
});
