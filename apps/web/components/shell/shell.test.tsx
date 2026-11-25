// @vitest-environment jsdom
import { UiProvider } from '@habit/ui';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '@/lib/i18n/config';
import { messages } from '@/lib/i18n/messages';
import { sections } from '@/lib/navigation/sections';
import { LanguageSwitcher } from './language-switcher';
import { MobileNav } from './mobile-nav';
import { NavLink } from './nav-link';
import { RouteFocus } from './route-focus';
import { SkipLink } from './skip-link';

/** The locale-aware navigation, reduced to plain anchors with the URL it would produce. */
const nav = vi.hoisted(() => ({ pathname: '/overview', locale: 'en' }));
vi.mock('@/lib/i18n/navigation', () => ({
  usePathname: () => nav.pathname,
  Link: ({
    href,
    locale,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; locale?: string }) => (
    <a href={`/${locale ?? nav.locale}${href === '/' ? '' : href}`} {...props} />
  ),
}));

beforeAll(() => {
  // jsdom lacks the layout APIs Radix measures with.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  nav.pathname = '/overview';
  nav.locale = 'en';
});

afterEach(() => {
  cleanup();
  document.head.querySelectorAll('style').forEach((style) => style.remove());
});

function wrap(locale: Locale, children: ReactNode) {
  nav.locale = locale;
  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <UiProvider dir={locale === 'fa' ? 'rtl' : 'ltr'}>{children}</UiProvider>
    </NextIntlClientProvider>
  );
}

const section = (key: string) => {
  const found = sections.find((s) => s.key === key);
  if (!found) throw new Error(key);
  return found;
};

describe('NavLink', () => {
  it('marks the current section, including pages below it, with aria-current="page"', () => {
    nav.pathname = '/habits/123';
    render(
      wrap(
        'en',
        <ul>
          <li>
            <NavLink section={section('habits')} variant="sidebar" />
          </li>
          <li>
            <NavLink section={section('goals')} variant="sidebar" />
          </li>
        </ul>,
      ),
    );
    const habits = screen.getByRole('link', { name: 'Habits' });
    expect(habits.getAttribute('aria-current')).toBe('page');
    expect(habits.getAttribute('href')).toBe('/en/habits');
    expect(screen.getByRole('link', { name: 'Goals' }).getAttribute('aria-current')).toBeNull();
  });

  it('uses Persian labels and flips only direction-bearing icons in RTL', () => {
    render(
      wrap(
        'fa',
        <>
          <NavLink section={section('tasks')} variant="bar" />
          <NavLink section={section('habits')} variant="bar" />
        </>,
      ),
    );
    const tasks = screen.getByRole('link', { name: 'کارها' });
    expect(tasks.getAttribute('href')).toBe('/fa/tasks');
    expect(tasks.querySelector('svg')?.getAttribute('class')).toContain('rtl:-scale-x-100');
    expect(tasks.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const habits = screen.getByRole('link', { name: 'عادت‌ها' });
    expect(habits.querySelector('svg')?.getAttribute('class')).not.toContain('rtl:');
  });
});

describe('MobileNav', () => {
  it('shows four sections and "More" in a labelled navigation landmark', () => {
    render(wrap('en', <MobileNav />));
    const bar = screen.getByRole('navigation', { name: 'Main' });
    const links = within(bar).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Overview', 'Habits', 'Tasks', 'Planner']);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    const more = within(bar).getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the other sections in a modal sheet; Escape closes it and focus returns', async () => {
    const user = userEvent.setup();
    render(wrap('en', <MobileNav />));
    const more = screen.getByRole('button', { name: 'More' });
    await user.click(more);
    const sheet = screen.getByRole('dialog', { name: 'More sections' });
    const list = within(sheet).getByRole('navigation', { name: 'More sections' });
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Goals', 'Focus', 'Journal', 'Insights', 'AI Coach', 'Settings']);
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(sheet.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('closes the sheet when another section is chosen', async () => {
    const user = userEvent.setup();
    render(wrap('en', <MobileNav />));
    await user.click(screen.getByRole('button', { name: 'More' }));
    const goals = within(screen.getByRole('dialog')).getByRole('link', { name: 'Goals' });
    goals.addEventListener('click', (event) => event.preventDefault());
    await user.click(goals);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Leaving the page: focus is left for RouteFocus (main), not returned to "More".
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'More' }));
  });

  it('returns focus to "More" when the current section is chosen (no navigation)', async () => {
    nav.pathname = '/goals';
    const user = userEvent.setup();
    render(wrap('en', <MobileNav />));
    const more = screen.getByRole('button', { name: 'More' });
    await user.click(more);
    const goals = within(screen.getByRole('dialog')).getByRole('link', { name: 'Goals' });
    goals.addEventListener('click', (event) => event.preventDefault());
    await user.click(goals);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('highlights "More" while a section inside it is open (fa, rtl)', async () => {
    nav.pathname = '/settings';
    const user = userEvent.setup();
    render(wrap('fa', <MobileNav />));
    const more = screen.getByRole('button', { name: 'بیشتر' });
    expect(more.dataset.active).toBe('true');
    await user.click(more);
    const sheet = screen.getByRole('dialog', { name: 'بخش‌های دیگر' });
    expect(within(sheet).getByRole('link', { name: 'تنظیمات' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
});

describe('LanguageSwitcher', () => {
  it.each([
    ['en', '/habits', '/fa/habits', 'fa', 'فارسی'],
    ['fa', '/settings', '/en/settings', 'en', 'English'],
  ] as const)('%s on %s links to %s', (locale, pathname, href, other, label) => {
    nav.pathname = pathname;
    render(wrap(locale, <LanguageSwitcher />));
    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(href);
    expect(link.getAttribute('hreflang')).toBe(other);
    expect(link.getAttribute('lang')).toBe(other);
  });
});

describe('SkipLink and RouteFocus', () => {
  it('skips to the main region', () => {
    render(<SkipLink targetId="main" label="Skip to main content" />);
    expect(screen.getByRole('link', { name: 'Skip to main content' }).getAttribute('href')).toBe(
      '#main',
    );
  });

  it('moves focus to main after client-side navigation, not on the first render', () => {
    const view = render(
      <>
        <button type="button">link</button>
        <main id="main" tabIndex={-1} />
        <RouteFocus targetId="main" />
      </>,
    );
    const button = screen.getByRole('button');
    button.focus();
    view.rerender(
      <>
        <button type="button">link</button>
        <main id="main" tabIndex={-1} />
        <RouteFocus targetId="main" />
      </>,
    );
    expect(document.activeElement).toBe(button);
    nav.pathname = '/habits';
    view.rerender(
      <>
        <button type="button">link</button>
        <main id="main" tabIndex={-1} />
        <RouteFocus targetId="main" />
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});
