import { id, inReadingOrder, SCORES, selectRange, stage } from '../editor.mjs';

export default {
  id: 'history',
  chapter: 'History and compare',
  async setup(t) {
    await stage(t, { score: SCORES.ode });
  },
  async run(t) {
    await t.caption('Save a checkpoint whenever you like: Ctrl+S.', { say: 'Save a checkpoint whenever you like, with Control S.' });
    await t.hold(700);
    await t.key('Control+s', { after: 900 });
    await t.callout(id(t, 'status-checkpoint'), '', { pad: 4 });
    await t.hold(2000);
    await t.snap('checkpointed');
    await t.clearCallout();

    await t.caption('Then keep working.');
    let notes = await inReadingOrder(t);
    await selectRange(t, notes[8], notes[11]);
    await t.key('ArrowUp', { after: 900 });
    notes = await inReadingOrder(t);
    await selectRange(t, notes[19], notes[22]);
    await t.key('ArrowDown', { after: 900 });
    await t.snap('edited');

    await t.caption('History keeps your checkpoints. Compare one with the score as it is now.');
    await t.click(id(t, 'activity-history'), { after: 1900 });
    await t.snap('history');
    await t.click(id(t, 'btn-checkpoint-compare-1'), { after: 0 });
    await t.cut(
      async () => {
        await id(t, 'compare-pane-right').locator('svg').first().waitFor({ state: 'visible', timeout: 60000 });
        await id(t, 'compare-pane-left').locator('svg').first().waitFor({ state: 'visible', timeout: 60000 });
        await id(t, 'compare-left-highlight').first().waitFor({ state: 'visible', timeout: 60000 });
        await t.page.getByRole('button', { name: /Overwrite right with/ }).first().waitFor({ state: 'visible', timeout: 60000 });
        await t.page.waitForTimeout(900);
      },
      { label: 'Loading skipped' },
    );
    await t.hold(2600);
    await t.snap('compare');

    await t.caption('Changed bars are marked on both sides. An arrow carries a change across.', {
      say: 'Changed bars are marked on both sides, and an arrow carries a change across.',
    });
    await t.hold(2200);
    await t.click(t.page.getByRole('button', { name: /Overwrite right with/ }).first(), { after: 3200 });
    await t.snap('taken');
    await t.click(id(t, 'compare-close'), { after: 1200 });
    await t.snap('closed');
  },
};
