import { id, SCORES, stage } from '../editor.mjs';

export default {
  id: 'source',
  chapter: 'Score source',
  async setup(t) {
    await stage(t, { score: SCORES.ode });
  },
  async run(t) {
    await t.caption('The score’s MusicXML is one click away: read it, or edit it and apply.', {
      say: 'The score’s Music X M L is one click away. Read it, or edit it and apply.',
    });
    await t.hold(500);
    await t.click(id(t, 'panel-score-source'), { after: 1800 });
    await t.snap('xml-open');
    // Scroll the source down to the notes.
    await t.move(id(t, 'xml-editor'));
    for (let i = 0; i < 6; i++) {
      await t.page.mouse.wheel(0, 260);
      await t.hold(330);
    }
    await t.hold(1500);
    await t.snap('xml-scrolled');
    await t.click(id(t, 'panel-score-source'), { after: 700 });
  },
};
