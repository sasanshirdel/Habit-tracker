/**
 * The primary sections of the app and where they appear (backlog P1-11; ARCHITECTURE §7, PRD §2.3).
 *
 * - `sidebar`: every section, in this order, on tablet (icon rail) and desktop (full sidebar).
 * - `mobile`: `primary` sections get a slot in the bottom bar (≤ 5 slots incl. "More"); the rest
 *   are listed in the "More" sheet. Settings sits last in "More", as §7 maps it.
 * - `mirrorInRtl`: the icon shows reading order or direction (a list with leading checkboxes), so
 *   it is flipped in RTL. Objects, clocks, checkmarks and charts-as-symbols are not (ADR-0004).
 *
 * Labels come from the `nav.<key>` messages; page copy from `sections.<key>`.
 *
 * Overview lives at `/{locale}/overview`, not at `/{locale}`: the locale root is the public
 * landing page (§7 "Public") until authentication (Phase 2) decides who sees which. Recorded in
 * ARCHITECTURE §7 as an interim choice for the owner.
 */
export const sectionKeys = [
  'overview',
  'habits',
  'goals',
  'tasks',
  'planner',
  'focus',
  'journal',
  'insights',
  'coach',
  'settings',
] as const;

export type SectionKey = (typeof sectionKeys)[number];

export interface Section {
  key: SectionKey;
  /** Locale-less path; use with the locale-aware `Link` from `@/lib/i18n/navigation`. */
  href: `/${string}`;
  mobile: 'primary' | 'more';
  mirrorInRtl: boolean;
}

export const sections: readonly Section[] = [
  { key: 'overview', href: '/overview', mobile: 'primary', mirrorInRtl: false },
  { key: 'habits', href: '/habits', mobile: 'primary', mirrorInRtl: false },
  { key: 'goals', href: '/goals', mobile: 'more', mirrorInRtl: false },
  { key: 'tasks', href: '/tasks', mobile: 'primary', mirrorInRtl: true },
  { key: 'planner', href: '/planner', mobile: 'primary', mirrorInRtl: false },
  { key: 'focus', href: '/focus', mobile: 'more', mirrorInRtl: false },
  { key: 'journal', href: '/journal', mobile: 'more', mirrorInRtl: false },
  { key: 'insights', href: '/insights', mobile: 'more', mirrorInRtl: false },
  { key: 'coach', href: '/coach', mobile: 'more', mirrorInRtl: false },
  { key: 'settings', href: '/settings', mobile: 'more', mirrorInRtl: false },
];

export const mobilePrimarySections = sections.filter((s) => s.mobile === 'primary');
export const mobileMoreSections = sections.filter((s) => s.mobile === 'more');

/** The home of the signed-in app (the brand link and the landing page's call to action). */
export const appHomeHref = '/overview';

/**
 * Whether `pathname` (locale-less, as next-intl's `usePathname` returns it) is inside the section
 * at `href`: the section itself or any page below it (`/habits/123` is in Habits).
 */
export function isActiveSection(pathname: string, href: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return path === href || path.startsWith(`${href}/`);
}
