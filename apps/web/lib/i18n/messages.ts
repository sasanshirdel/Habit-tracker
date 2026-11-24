import type { Locale } from '@habit/localization';
import en from './messages/en.json';
import fa from './messages/fa.json';

/** English is the reference catalogue: its shape types every `t('…')` key (see `global.d.ts`). */
export type Messages = typeof en;

/**
 * All UI strings, per locale. Both catalogues must have identical keys and ICU arguments — the
 * parity test (`i18n.test.ts`) fails CI otherwise. Bundled statically: the catalogues are small,
 * and a missing file is a build error instead of a runtime one.
 */
export const messages: Record<Locale, Messages> = { en, fa };
