import type { Page } from '@playwright/test';
import { directionOf, locales, viewports } from './env';
import { expect, messages, test } from './fixtures';

/**
 * Keyboard journey through the shell (P1-11 criteria moved to P1-13): skip link → main, the
 * "More" sheet (open, focus trap, Escape returns focus) and navigating from it (focus on main).
 */

const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');

for (const locale of locales) {
  const t = messages(locale);

  test.describe(`phone · /${locale}`, () => {
    test.use({ viewport: viewports.phone });

    test('skip link, then the "More" sheet by keyboard only', async ({ page }) => {
      await page.goto(`/${locale}/overview`);

      // The skip link is the first stop and becomes visible when focused.
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: t.shell!.skipToContent! });
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport();
      await page.keyboard.press('Enter');
      expect(await activeId(page)).toBe('main');

      // Open "More" from the keyboard.
      const more = page.getByRole('button', { name: t.nav!.more! });
      await more.focus();
      await page.keyboard.press('Enter');
      const sheet = page.getByRole('dialog', { name: t.nav!.moreTitle! });
      await expect(sheet).toBeVisible();

      // Focus is trapped: Tab and Shift+Tab never leave the sheet.
      for (const key of [
        'Tab',
        'Tab',
        'Tab',
        'Tab',
        'Tab',
        'Tab',
        'Tab',
        'Shift+Tab',
        'Shift+Tab',
      ]) {
        await page.keyboard.press(key);
        expect(
          await sheet.evaluate((el) => el.contains(document.activeElement)),
          `focus stays in the sheet after ${key}`,
        ).toBe(true);
      }

      // Escape closes it and returns focus to "More".
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(more).toBeFocused();

      // Reopen, move to "Goals" with Tab, and follow it with Enter.
      await page.keyboard.press('Enter');
      await expect(sheet).toBeVisible();
      const goals = sheet.getByRole('link', { name: t.nav!.goals! });
      for (
        let i = 0;
        i < 12 && !(await goals.evaluate((el) => el === document.activeElement));
        i++
      ) {
        await page.keyboard.press('Tab');
      }
      await expect(goals).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(page).toHaveURL(`/${locale}/goals`);
      await expect(sheet).toBeHidden();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.nav!.goals!);
      // Focus moves to the new page's main region, not back to "More".
      await expect.poll(() => activeId(page)).toBe('main');
      // "More" now shows that the current section is inside it.
      await expect(more).toHaveAttribute('data-active', 'true');
    });
  });

  test.describe(`desktop · /${locale}`, () => {
    test.use({ viewport: viewports.desktop });

    test('the focused skip link appears at the inline start and sidebar links navigate', async ({
      page,
    }) => {
      await page.goto(`/${locale}/overview`);
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: t.shell!.skipToContent! });
      await expect(skip).toBeFocused();
      const skipBox = (await skip.boundingBox())!;
      const width = await page.evaluate(() => document.documentElement.clientWidth);
      if (directionOf[locale] === 'rtl') expect(skipBox.x).toBeGreaterThan(width / 2);
      else expect(skipBox.x + skipBox.width).toBeLessThan(width / 2);

      const habits = page
        .locator('nav[data-nav="sidebar"]')
        .getByRole('link', { name: t.nav!.habits! });
      await habits.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`/${locale}/habits`);
      await expect(habits).toHaveAttribute('aria-current', 'page');
      await expect.poll(() => activeId(page)).toBe('main');
    });
  });
}
