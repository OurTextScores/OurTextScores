import { id, inReadingOrder, SCORES, selectRange, stage } from '../editor.mjs';

export default {
  id: 'marks',
  chapter: 'Marks and text',
  async setup(t) {
    await stage(t, { score: SCORES.ode, dock: true });
  },
  async run(t) {
    let notes = await inReadingOrder(t);

    t.caption('Palettes hold the marks. Select a note, then click one to apply it.');
    await t.click(notes[0]);
    await t.click(id(t, 'palette-search'));
    await t.text('dyn', { delay: 110 });
    await t.hold(700);
    await t.click(id(t, 'palette-item-dynamic-8'), { after: 1500 }); // mf
    await t.snap('dynamic');
    await t.click(id(t, 'btn-dock-close'), { after: 500 });
    await t.click(id(t, 'btn-fit-width'), { after: 1000 });

    t.caption('Slurs, hairpins and articulations have MuseScore’s keys: S, <, Shift+S.');
    notes = await inReadingOrder(t);
    await selectRange(t, notes[0], notes[3]);
    await t.key('s', { after: 1100 });
    await t.snap('slur');
    notes = await inReadingOrder(t);
    await selectRange(t, notes[4], notes[7]);
    await t.key('Shift+Comma', { after: 1100 });
    await t.snap('hairpin');
    notes = await inReadingOrder(t);
    await selectRange(t, notes[8], notes[11]);
    await t.key('Shift+S', { after: 1200 });
    await t.snap('staccato');

    t.caption('Chord symbols and other text come from the Add menu.');
    notes = await inReadingOrder(t);
    await t.click(notes[0]);
    await t.click(id(t, 'menu-add'));
    await t.hover(id(t, 'menu-sub-text'), { after: 900 });
    await t.click(id(t, 'menu-item-btn-text-harmony-standard'));
    await t.hold(500);
    await t.text('D', { after: 500 });
    await t.click(t.page.getByRole('button', { name: 'OK', exact: true }), { after: 1100 });
    await t.snap('chord');

    t.caption('Set the tempo, and change key, time signature or clef from the toolbar.');
    await t.click(id(t, 'btn-tempo-open'));
    await t.replaceText(id(t, 'input-tempo-bpm'), '108');
    await t.snap('tempo-dialog');
    await t.click(id(t, 'btn-tempo-apply'), { after: 1300 });
    await t.snap('tempo');
    // Point at the signature and clef controls without opening them: the key list draws its
    // sharps and flats as empty boxes (it uses music-font characters in the text font).
    await t.callout(id(t, 'strip-group-layout-signatures'), '', { pad: 3 });
    await t.hover(id(t, 'dropdown-key'), { after: 1500 });
    await t.callout(id(t, 'strip-group-score-clefs'), '', { pad: 3 });
    await t.hover(id(t, 'dropdown-clef'), { after: 1500 });
    await t.snap('signatures');
    await t.clearCallout();
    await t.hold(400);
  },
};
