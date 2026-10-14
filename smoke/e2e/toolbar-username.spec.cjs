// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Toolbar user identity', () => {
  for (const identity of [
    { name: 'a_very_long_username', username: 'a_very_long_username' },
    { name: 'A User With A Particularly Long Display Name', username: undefined },
  ]) {
    for (const width of [1280, 390]) {
      test(`the full ${identity.username ? 'username' : 'display name'} remains readable at ${width}px`, async ({ page }) => {
        const { username, name } = identity;
        await page.setViewportSize({ width, height: 844 });
        await page.route('**/api/auth/session', (route) => route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ user: { name, username, email: 'toolbar@example.test' }, expires: '2099-01-01T00:00:00.000Z' }),
        }));
        await page.route('**/api/proxy/notifications/unread-count', (route) => route.fulfill({
          contentType: 'application/json', body: '{"unreadCount":0}',
        }));
        await page.route('**/api/proxy/users/me', (route) => route.fulfill({
          contentType: 'application/json', body: JSON.stringify({ user: { username } }),
        }));
        await page.goto('/datasets');
        const profile = username
          ? page.getByRole('link', { name: username, exact: true })
          : page.locator('header').getByText(name, { exact: true });
        if (username) await expect(profile).toHaveAttribute('href', `/users/${username}`);
        await profile.scrollIntoViewIfNeeded();
        await expect(profile).toBeInViewport();
        const rendered = await profile.evaluate((element) => ({
          width: element.clientWidth,
          textWidth: element.scrollWidth,
          shrink: getComputedStyle(element).flexShrink,
          overflow: getComputedStyle(element).textOverflow,
        }));
        expect(rendered.width).toBeGreaterThan(0);
        expect(rendered.width).toBeGreaterThanOrEqual(rendered.textWidth);
        expect(rendered.shrink).toBe('0');
        expect(rendered.overflow).not.toBe('ellipsis');
      });
    }
  }
});
