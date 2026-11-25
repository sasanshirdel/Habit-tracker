import { directionOf, locales } from './env';
import { expect, messages, test } from './fixtures';

/**
 * Locale and direction in a real browser (P1-10, deferred "Playwright check of dir/lang"): the
 * document's `lang`/`dir`, the computed direction the layout actually uses, negotiation of `/`
 * from the browser's language, and the language switcher.
 */
for (const locale of locales) {
  test(`/${locale} renders lang="${locale}" dir="${directionOf[locale]}" in the browser`, async ({
    page,
  }) => {
    await page.goto(`/${locale}`);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', locale);
    await expect(html).toHaveAttribute('dir', directionOf[locale]);
    expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe(
      directionOf[locale],
    );
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      messages(locale).home!.heading!,
    );
  });
}

test.describe('negotiates / from the browser language', () => {
  test.use({ locale: 'fa-IR' });
  test('a Persian browser lands on /fa', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/fa');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});

test.describe('negotiates / from the browser language (en)', () => {
  test.use({ locale: 'en-US' });
  test('an English browser lands on /en, and switching to Persian is remembered', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/en');

    await page.getByRole('link', { name: messages('en').language!.switchTo! }).click();
    await expect(page).toHaveURL('/fa');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // The choice is stored in NEXT_LOCALE and wins over Accept-Language on the next visit to `/`.
    await page.goto('/');
    await expect(page).toHaveURL('/fa');
  });
});
