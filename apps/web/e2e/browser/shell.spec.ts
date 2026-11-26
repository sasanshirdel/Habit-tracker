import type { Page } from '@playwright/test';
import { directionOf, locales, viewports, type Locale, type ViewportName } from './env';
import { expect, messages, openApp, test } from './fixtures';

/**
 * The application shell at 3 viewports × 2 locales (P1-11 criteria moved to P1-13): which
 * navigation is visible, that the sidebar sits at the inline start (right in `fa`), that the bottom
 * bar follows the reading direction, and that nothing overflows horizontally. The automatic page
 * guard adds "no CSP violations, no console errors".
 */

/** Width of the client area (excludes a classic scrollbar, which Chromium keeps on the right). */
const clientWidth = (page: Page) => page.evaluate(() => document.documentElement.clientWidth);

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, width } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    width: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'no horizontal overflow').toBeLessThanOrEqual(width);
}

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).boundingBox();
  if (!found) throw new Error(`${selector} has no layout box`);
  return found;
}

for (const locale of locales) {
  const nav = messages(locale).nav!;
  const rtl = directionOf[locale] === 'rtl';

  for (const name of Object.keys(viewports) as ViewportName[]) {
    test.describe(`${name} · /${locale}`, () => {
      test.use({ viewport: viewports[name] });

      test(`shows the ${name} navigation in ${directionOf[locale]}`, async ({ page }) => {
        await openApp(page, `/${locale}/overview`);
        await expect(page.locator('html')).toHaveAttribute('dir', directionOf[locale]);
        await expect(page.getByRole('main')).toBeVisible();

        const sidebar = page.locator('nav[data-nav="sidebar"]');
        const bottomBar = page.locator('nav[data-nav="bottom"]');
        // Overview is the current section wherever the navigation is.
        const current = page.locator('nav[data-nav] a[aria-current="page"]:visible');
        await expect(current).toHaveCount(1);
        await expect(current).toHaveAttribute('href', `/${locale}/overview`);

        if (name === 'phone') {
          await expect(bottomBar).toBeVisible();
          await expect(sidebar).toBeHidden();
          await expectBottomBar(page, locale, rtl);
        } else {
          await expect(sidebar).toBeVisible();
          await expect(bottomBar).toBeHidden();
          const width = await clientWidth(page);
          const bar = await box(page, 'nav[data-nav="sidebar"]');
          // Icon rail (w-24) on tablets, full sidebar (w-64) on desktops.
          expect(bar.width).toBe(name === 'tablet' ? 96 : 256);
          // Inline start: the left edge in LTR, the right edge in RTL.
          if (rtl) expect(Math.round(bar.x + bar.width)).toBe(width);
          else expect(Math.round(bar.x)).toBe(0);
          // All ten sections, labelled in this locale.
          await expect(sidebar.getByRole('link')).toHaveCount(11); // brand + 10 sections
          await expect(sidebar.getByRole('link', { name: nav.settings! })).toBeVisible();
        }
        await expectNoHorizontalOverflow(page);
      });
    });
  }
}

async function expectBottomBar(page: Page, locale: Locale, rtl: boolean) {
  const nav = messages(locale).nav!;
  const bar = page.locator('nav[data-nav="bottom"]');
  const items = [
    bar.getByRole('link', { name: nav.overview! }),
    bar.getByRole('link', { name: nav.habits! }),
    bar.getByRole('link', { name: nav.tasks! }),
    bar.getByRole('link', { name: nav.planner! }),
    bar.getByRole('button', { name: nav.more! }),
  ];
  const xs: number[] = [];
  for (const item of items) {
    await expect(item).toBeVisible();
    xs.push((await item.boundingBox())!.x);
  }
  // Reading order: Overview first at the inline start, "More" last at the inline end.
  const sorted = [...xs].sort((a, b) => (rtl ? b - a : a - b));
  expect(xs).toEqual(sorted);

  // Pinned to the bottom of the viewport.
  const barBox = await bar.boundingBox();
  const viewport = page.viewportSize()!;
  expect(Math.round(barBox!.y + barBox!.height)).toBe(viewport.height);
}
