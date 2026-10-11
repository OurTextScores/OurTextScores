import { id, inReadingOrder, SCORES, stage } from '../editor.mjs';

export default {
  id: 'layout',
  chapter: 'Layout and instruments',
  async setup(t) {
    await stage(t, { score: SCORES.ode, dock: true });
  },
  async run(t) {
    let notes = await inReadingOrder(t);

    t.caption('Break a line where you want it: select a bar and press Enter.');
    await t.hold(800);
    await t.click(notes[14], { after: 700 });
    await t.key('Enter', { after: 2600 });
    await t.snap('line-break');

    t.caption('Insert bars wherever they are needed.');
    await t.click(id(t, 'btn-measures-open'), { after: 700 });
    await t.replaceText(id(t, 'input-measure-count'), '4');
    await t.snap('measures-dialog');
    await t.click(id(t, 'btn-insert-measures'), { after: 2800 });
    await t.snap('measures-added');

    t.caption('And add instruments from the side panel.');
    await t.click(id(t, 'dock-tab-instruments'), { after: 900 });
    await t.click(id(t, 'select-instrument-add'), { after: 700 });
    await t.snap('instrument-list');
    await t.click(t.page.getByRole('option', { name: 'Violoncello', exact: true }).first(), { after: 600 });
    await t.click(id(t, 'btn-add-instrument'), { after: 2600 });
    await t.snap('instrument-added');
  },
};
