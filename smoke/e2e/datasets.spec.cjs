// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Public dataset catalogue', () => {
  test.beforeEach(async ({ page }) => {
    // This page is public and needs no scanner/API/model services.
    await page.route('**/api/auth/session', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    }));
  });

  test('signed-out visitors can reach the page from the main navigation', async ({ page }) => {
    await page.goto('/welcome');
    await page.getByRole('link', { name: 'Datasets', exact: true }).click();
    await expect(page).toHaveURL(/\/datasets$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Datasets' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'v11 recipe', exact: true })).toHaveAttribute('href', /OurTextScores\/homr\/tree\/[a-f0-9]{40}/);
  });

  test('each release exposes its own archive links and checksums', async ({ page }, testInfo) => {
    await page.goto('/datasets');
    const ossq = page.getByRole('article', { name: 'OpenScore String Quartets', exact: true });
    await ossq.locator('summary').click();
    await expect(ossq.getByRole('link', { name: 'valid-0000.tar.zst' })).toBeVisible();
    await expect(ossq.getByRole('link', { name: 'valid-0000.tar.zst' })).toHaveAttribute('href', /\/ossq-scanned-v2\/valid-0000\.tar\.zst$/);
    await expect(ossq.locator('tbody tr')).toHaveCount(6);
    await expect(ossq.locator('tbody code').first()).toHaveText(/^[a-f0-9]{64}$/);
    const expanded = page.getByRole('article', { name: 'PDMX · expanded v2', exact: true });
    await expanded.locator('summary').click();
    await expect(expanded.locator('tbody tr')).toHaveCount(118);
    await expect(expanded.getByRole('link', { name: 'valid-0000.tar.zst' })).toHaveAttribute('href', /\/pdmx-homr-v2\/shards\/valid-0000\.tar\.zst$/);
    await expect(page.getByRole('link', { name: 'Lieder source provenance' })).toHaveAttribute('href', 'https://huggingface.co/datasets/jhlusko/lieder-omr-private-all-sources');
    await page.screenshot({ path: testInfo.outputPath('datasets-desktop.png'), fullPage: true });
  });

  test('the page remains readable on a narrow screen and in dark mode', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await page.goto('/datasets');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByRole('heading', { name: 'Staff-crop downloads', exact: true })).toBeVisible();
    const corpus = page.getByRole('article', { name: 'OpenScore String Quartets', exact: true });
    await corpus.locator('summary').click();
    await expect(corpus.getByRole('link', { name: 'train-0000.tar.zst' })).toBeVisible();
    const widths = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(widths.content).toBeLessThanOrEqual(widths.viewport);
    await page.screenshot({ path: testInfo.outputPath('datasets-mobile-dark.png'), fullPage: true });
  });
});
