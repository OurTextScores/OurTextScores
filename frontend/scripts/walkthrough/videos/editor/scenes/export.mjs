import { id, SCORES, stage } from '../editor.mjs';

export default {
  id: 'export',
  chapter: 'Export and share',
  async setup(t) {
    await stage(t, { score: SCORES.ode });
  },
  async run(t) {
    t.caption('Export a PDF, an image, a MuseScore or MusicXML file, ABC, MIDI or audio.');
    await t.hold(500);
    await t.click(id(t, 'menu-file'));
    await t.hover(id(t, 'menu-sub-export'), { after: 900 });
    for (const item of ['png', 'mscz', 'musicxml', 'abc', 'midi', 'audio']) {
      await t.hover(id(t, `menu-item-file.export.${item}`), { after: 380 });
    }
    await t.snap('export-menu');
    const download = t.page.waitForEvent('download', { timeout: 60000 });
    await t.click(id(t, 'menu-item-file.export.pdf'), { after: 0 });
    const file = await download;
    await t.hold(1800);
    await t.snap('exported');
    if (process.env.WALKTHROUGH_VERBOSE) console.log(`    exported ${file.suggestedFilename()}`);

    t.caption('Or make a link that opens a score from Google Drive.');
    await t.click(id(t, 'btn-create-share-link'), { after: 3200 });
    await t.snap('share');
    await t.click(t.page.getByRole('button', { name: 'Close', exact: true }), { after: 800 });
  },
};
