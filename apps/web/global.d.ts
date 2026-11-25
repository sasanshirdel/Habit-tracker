import type { Locale } from '@habit/localization';
import type { formats } from './lib/i18n/formats';
import type { Messages } from './lib/i18n/messages';

// Typed next-intl: unknown message keys, locales and format names are compile errors.
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
    Formats: typeof formats;
  }
}
