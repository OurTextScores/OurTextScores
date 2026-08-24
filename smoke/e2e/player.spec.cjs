// @ts-check
const { test, expect } = require('@playwright/test');
const { join } = require('node:path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_SCORE_PATH = '/score-editor/test_scores/playback_timeline.musicxml';
const TEST_SCORE_FILE = join(
  __dirname,
  '..',
  '..',
  'frontend',
  'public',
  'score-editor',
  'test_scores',
  'playback_timeline.musicxml',
);

test.describe('Standalone score player', () => {
  test('opens score URLs and local files in the playback surface', async ({ page }) => {
    await page.goto(`${BASE_URL}/player?score=${encodeURIComponent(TEST_SCORE_PATH)}`);

    await expect(page.getByRole('heading', { name: 'Score Player' })).toBeVisible();
    const playerFrame = page.getByTestId('standalone-player-frame');
    const playerSrc = new URL(await playerFrame.getAttribute('src'), BASE_URL);
    expect(playerSrc.searchParams.get('score')).toBe(TEST_SCORE_PATH);
    expect(playerSrc.searchParams.get('embed')).toBe('player');
    await expect(
      page.frameLocator('[data-testid="standalone-player-frame"]').getByTestId('player-svg').locator('svg'),
    ).toBeVisible({ timeout: 60000 });

    await page.getByLabel('Load file').setInputFiles(TEST_SCORE_FILE);
    await expect(page.getByText('Local file', { exact: true })).toBeVisible();
    const localPlayerSrc = new URL(await playerFrame.getAttribute('src'), BASE_URL);
    expect(localPlayerSrc.searchParams.get('score')).toMatch(/^blob:/);
    await expect(
      page.frameLocator('[data-testid="standalone-player-frame"]').getByTestId('player-svg').locator('svg'),
    ).toBeVisible({ timeout: 60000 });
  });
});
