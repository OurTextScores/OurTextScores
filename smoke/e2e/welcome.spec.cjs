// @ts-check
const { test, expect } = require('@playwright/test');

test('welcome keeps the feature showcase, contribution cards and walkthrough carousel usable on desktop and mobile', async ({ page }) => {
  // Check our page independently of YouTube's availability.
  await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({
    contentType: 'text/html', body: '<html><body>Walkthrough player</body></html>',
  }));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { name: 'See it in action' })).toBeVisible();
    await page.getByRole('tab', { name: 'Score Editor' }).click();
    await expect(page.getByRole('link', { name: 'Open Example in Score Editor' })).toBeVisible();

    const contributions = page.getByRole('region', { name: 'Get Involved' });
    await expect(contributions.locator('article')).toHaveCount(8);
    await expect(contributions.getByRole('heading', { name: 'Flag Mismatched Sources' })).toBeVisible();
    const carousel = page.getByRole('region', { name: 'Watch the walkthroughs' });
    await expect(page.locator('section[aria-labelledby="see-it"] + section[aria-labelledby="walkthroughs"]')).toBeVisible();
    for (const [title, id] of [['Scanner walkthrough', 'cSDI19N7kcE'], ['Score Editor walkthrough', '65ISfJhIO4s'], ['Website walkthrough', '-Z09sxFUjys']]) {
      const frame = page.locator(`iframe[title="${title}"]`);
      await expect(frame).toBeVisible();
      await expect(frame).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/${id}`);
      await expect(page.getByRole('link', { name: `Watch the ${title} on YouTube` }))
        .toHaveAttribute('href', `https://www.youtube.com/watch?v=${id}`);
      await expect(carousel.locator('iframe')).toHaveCount(1);
      const bounds = await frame.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds.width / bounds.height).toBeCloseTo(16 / 9, 1);
      await carousel.getByRole('button', { name: 'Next walkthrough' }).click();
    }
    await expect(page.getByTitle('Scanner walkthrough')).toBeVisible();
    await carousel.getByRole('button', { name: 'Previous walkthrough' }).click();
    await expect(page.getByTitle('Website walkthrough')).toBeVisible();
    await carousel.getByRole('button', { name: 'Editor', exact: true }).click();
    await expect(page.getByTitle('Score Editor walkthrough')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  }
});
