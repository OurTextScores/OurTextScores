import path from 'node:path';
import { visit, warmUp } from '../site.mjs';

const ASSETS = path.resolve(import.meta.dirname, '../assets');

export default {
  id: 'player',
  chapter: 'The player',
  async setup(t) {
    await visit(t, '/player');
  },
  async run(t) {
    const page = t.page;
    const player = page.frameLocator('iframe').first();

    await t.caption('The player opens any score, from a link or from your own computer.');
    await t.hold(600);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), t.click(page.getByText('Load file', { exact: true }))]);
    await t.cut(
      async () => {
        // Haydn's "Fifths" quartet. Not every score will do here: the player's sound breaks up
        // on some (Mozart's K. 465 from the same corpus is one), on the live site as well.
        await chooser.setFiles(path.join(ASSETS, 'haydn-op76-2.mxl'));
        await player.locator('svg .Note').first().waitFor({ state: 'visible', timeout: 180000 });
        await warmUp(t, player);
        await page.waitForTimeout(700);
      },
      { label: 'Loading: skipped' },
    );
    await t.hold(1500);
    await t.snap('loaded');

    // High in the frame: the controls this line is about are at the foot of it.
    await t.caption('It follows the music as it plays, and can save the result as a video.', { position: 'high' });
    await t.click(player.getByTestId('player-play'), { after: 300 });
    await t.hold(8500);
    await t.snap('playing');
    await t.hover(player.getByRole('button', { name: 'Follow score' }), { after: 1100 });
    await t.hover(player.getByTestId('player-export-video'), { after: 1500 });
    await t.snap('export');
    await t.click(player.getByRole('button', { name: /^pause/i }).first(), { after: 300 });
  },
};
