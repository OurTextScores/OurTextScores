import { id, menu, scoreReady, stage } from '../editor.mjs';

export default {
  id: 'note-entry',
  chapter: 'Write',
  async setup(t) {
    await stage(t);
    // Dialogs sit below the header and toolbar, and this one is tall enough that the toolbar
    // covers its top. With the tools hidden (a button in the toolbar's corner) all of it shows.
    await id(t, 'btn-tool-strip-toggle').click();
    await t.page.waitForTimeout(500);
  },
  async run(t) {
    await t.caption('Start a new score: title, instruments, key and time signature.', { position: 'low' });
    await t.hold(500);
    await menu(t, 'file', 'file.new');
    const modal = id(t, 'new-score-modal');
    await modal.waitFor();
    await t.hold(500);
    await t.click(modal.getByPlaceholder('Untitled score'));
    await t.text('Ode to Joy');
    await t.click(modal.getByPlaceholder('Composer'));
    await t.text('Ludwig van Beethoven');
    // Native <select> lists are drawn by the operating system and do not appear in the
    // recording, so the pointer rests on the control while its value changes.
    const instrument = modal.locator('select').nth(0);
    await t.hover(instrument, { after: 450 });
    await instrument.selectOption('violin');
    await t.hold(500);
    await t.click(modal.getByRole('button', { name: 'Add', exact: true }));
    await t.click(modal.getByRole('button', { name: 'Remove' }).first());
    const measures = modal.locator('input[type="number"]').first();
    await t.replaceText(measures, '8');
    const key = modal.locator('select').nth(1);
    await t.hover(key, { after: 450 });
    await key.selectOption('2');
    await t.hold(700);
    await t.snap('dialog');
    await t.click(modal.getByRole('button', { name: 'Create Score' }));
    await scoreReady(t);
    await t.hold(900);
    await t.click(id(t, 'btn-fit-width'));
    await t.hold(1100);
    await t.snap('created');

    await t.caption('Press N for note input, choose a duration, then type the note names.');
    await t.key('n', { after: 800 });
    await t.key('5', { after: 600 });
    const type = (keys) => t.keys(keys, { gap: 330, after: 330 });
    await type(['f', 'f', 'g', 'a']);
    await type(['a', 'g', 'f', 'e']);
    await type(['d', 'd', 'e', 'f']);
    await t.snap('three-bars');
    await t.key('.', { after: 420 });
    await t.key('f', { after: 420 });
    await t.key('4', { after: 420 });
    await t.key('e', { after: 420 });
    await t.key('6', { after: 420 });
    await t.key('e', { after: 700 });
    await t.key('Escape', { after: 700 });
    await t.snap('phrase');

    await t.caption('Press Play, or Space, to hear it.');
    await t.click(id(t, 'btn-play'), { after: 0 });
    await t.hold(9000);
    await t.snap('played');
    await t.click(id(t, 'btn-stop'), { after: 500 });
  },
};
