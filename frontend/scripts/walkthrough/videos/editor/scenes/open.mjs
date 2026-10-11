import path from 'node:path';
import { id, scoreReady, stage } from '../editor.mjs';

const FAURE = path.join(import.meta.dirname, '..', 'assets', 'faure-op121.mxl');

export default {
  id: 'open',
  chapter: 'Open a score',
  async setup(t) {
    await stage(t);
  },
  async run(t) {
    await t.caption('Open a MuseScore or MusicXML file. It stays on your computer.', {
      say: 'Open a MuseScore file or a MusicXML file. It stays on your computer.',
    });
    await t.hold(900);
    const chooser = t.page.waitForEvent('filechooser');
    await t.click(id(t, 'menu-file'));
    await t.hold(450);
    await t.click(id(t, 'menu-item-file.open'));
    const fileChooser = await chooser;
    // The file dialog belongs to the operating system and is not part of the page.
    await t.cut(
      async () => {
        await fileChooser.setFiles(FAURE);
        await scoreReady(t);
        await t.page.waitForFunction(() => document.querySelector('[data-testid="shell-title"]')?.textContent?.trim() !== 'Untitled score', null, { timeout: 8000 }).catch(() => {});
      },
      { label: 'Loading skipped' },
    );
    await t.snap('opened');
    await t.hold(2200);

    await t.caption('MuseScore’s engraving engine draws the score, running in your browser.');
    await t.click(t.page.getByRole('button', { name: 'Next page' }));
    await t.hold(2400);
    await t.snap('page-2');
    await t.click(id(t, 'btn-zoom-in'), { after: 500 });
    await t.click(id(t, 'btn-zoom-in'), { after: 1500 });
    await t.snap('zoomed');
    await t.click(id(t, 'btn-fit-width'), { after: 900 });
    await t.click(t.page.getByRole('button', { name: 'Previous page' }));
    await t.hold(1600);
  },
};
