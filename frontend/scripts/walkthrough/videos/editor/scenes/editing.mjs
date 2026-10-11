import { id, inReadingOrder, SCORES, selectRange, stage } from '../editor.mjs';

export default {
  id: 'editing',
  chapter: 'Edit',
  async setup(t) {
    await stage(t, { score: SCORES.phrase });
  },
  async run(t) {
    let notes = await inReadingOrder(t);

    t.caption('Click a note to select it. The arrow keys change its pitch.');
    await t.hold(700);
    await t.click(notes[8]);
    await t.key('ArrowUp', { times: 2, gap: 450, after: 800 });
    await t.snap('pitch-up');
    await t.key('ArrowDown', { times: 2, gap: 450, after: 600 });

    t.caption('Shift-click selects a range. Copy it, and paste it somewhere else.');
    notes = await inReadingOrder(t);
    await selectRange(t, notes[0], notes[7]);
    await t.hold(600);
    await t.snap('range');
    await t.key('Control+c', { after: 600 });
    const rests = await inReadingOrder(t, '.Rest');
    await t.click(rests[0]);
    await t.key('Control+v', { after: 1700 });
    await t.snap('pasted');

    // The drag comes after the other clicks on the score: the editor ignores the first click
    // that follows a drag, and a click that does nothing has no place in a walkthrough.
    t.caption('Or simply drag a note to a new pitch.');
    notes = await inReadingOrder(t);
    await t.drag(notes[3], { x: notes[3].x, y: notes[3].y - 14 }, { duration: 800 });
    await t.hold(900);
    await t.snap('dragged');

    t.caption('Every step can be undone, and the Edits panel jumps back to any point.');
    await t.key('Control+z', { after: 1000 });
    await t.click(id(t, 'menu-view'));
    await t.hold(350);
    await t.click(id(t, 'menu-item-view.panel.undoHistory'));
    await t.hold(1300);
    await t.snap('edits-panel');
    const rows = t.page.locator('[data-testid^="edit-row-"]');
    const count = await rows.count();
    // Newest first. Step back to before the paste, then forward again.
    await t.click(rows.nth(Math.min(2, count - 1)), { after: 1500 });
    await t.snap('jumped-back');
    await t.click(rows.nth(Math.min(1, count - 1)), { after: 1300 });
    await t.click(id(t, 'btn-dock-close'), { after: 700 });

    t.caption('Transpose the whole score in one step.');
    // With nothing selected the dialog acts on the whole score, key signature included.
    if (await t.page.locator('[data-testid="svg-container"] svg .selected').count()) await t.key('Escape', { after: 500 });
    await t.click(id(t, 'btn-transpose-dialog'));
    await t.hold(1600);
    await t.snap('transpose-dialog');
    await t.click(t.page.getByRole('dialog').getByRole('button', { name: 'Transpose', exact: true }));
    await t.hold(2600);
    await t.snap('transposed');
  },
};
