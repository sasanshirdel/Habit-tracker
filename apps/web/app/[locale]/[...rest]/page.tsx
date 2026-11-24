import { notFound } from 'next/navigation';

/**
 * Any unknown path under a locale (`/fa/nope`) gets the localized `[locale]/not-found.tsx`, inside
 * the locale layout (correct `lang`/`dir`), instead of Next's English-only built-in 404 (P1-10).
 * No static params exist for this segment, so it must accept any (the layout's `false` would
 * otherwise be inherited).
 *
 * Known Next.js 16.4 limitation: a `notFound()` thrown while rendering is drawn by the browser
 * from the RSC payload; the server HTML is Next's `<html id="__next_error__">` shell (status 404,
 * `noindex`) without `lang`/`dir`. Upstream: vercel/next.js#99793, #100596. Covered by
 * `e2e/routes.e2e.test.ts` so the fix is noticed when it lands.
 */
export const dynamicParams = true;

export default function CatchAllPage(): never {
  notFound();
}
