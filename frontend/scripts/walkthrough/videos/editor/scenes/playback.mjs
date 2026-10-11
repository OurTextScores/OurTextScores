import { id, inReadingOrder, SCORES, stage } from '../editor.mjs';

export default {
  id: 'playback',
  chapter: 'Playback',
  async setup(t) {
    await stage(t, { score: SCORES.faure });
  },
  async run(t) {
    await t.caption('Play the score with the built-in synthesizer. There is nothing to install.');
    await t.hold(500);
    await t.click(id(t, 'btn-play'), { after: 0 });
    await t.hold(9600);
    await t.snap('playing');
    await t.click(id(t, 'btn-stop'), { after: 700 });

    await t.caption('Start from any note, and add a metronome if you want one.');
    // First violin's entry in bar 5: the top staff of the first system.
    const firstViolin = await inReadingOrder(t, '.Note', { top: 370, bottom: 418 });
    await t.click(firstViolin[0], { after: 500 });
    await t.snap('selected');
    await t.click(id(t, 'btn-metronome'), { after: 500 });
    await t.click(id(t, 'btn-play-from-selection'), { after: 0 });
    await t.hold(8000);
    await t.snap('from-selection');
    await t.click(id(t, 'btn-stop'), { after: 600 });
  },
};
