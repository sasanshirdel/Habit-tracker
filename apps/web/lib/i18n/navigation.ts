/**
 * Locale-aware navigation (backlog P1-10). Use these instead of `next/link` / `next/navigation`
 * for internal links: they add the locale prefix, and switching locale with `<Link locale=…>`
 * also updates the `NEXT_LOCALE` cookie so `/` remembers the choice.
 */
import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
