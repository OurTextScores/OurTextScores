// @ts-check
const { test, expect } = require('@playwright/test');

test('welcome keeps the feature showcase, contribution cards and both walkthroughs usable on desktop and mobile', async ({ page }) => {
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
    for (const [title, id] of [['Website walkthrough', 'Ni-rVhAV884'], ['Score Editor walkthrough', 'AJj0lmKWtRA']]) {
      const frame = page.locator(`iframe[title="${title}"]`);
      await expect(frame).toBeVisible();
      await expect(frame).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/${id}`);
      await expect(page.getByRole('link', { name: `Watch the ${title} on YouTube` }))
        .toHaveAttribute('href', `https://www.youtube.com/watch?v=${id}`);
      const bounds = await frame.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds.width / bounds.height).toBeCloseTo(16 / 9, 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  }
});
