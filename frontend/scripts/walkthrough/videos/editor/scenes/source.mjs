import { id, SCORES, stage } from '../editor.mjs';

export default {
  id: 'source',
  chapter: 'Source and AI tools',
  async setup(t) {
    await stage(t, { score: SCORES.ode });
  },
  async run(t) {
    t.caption('The score’s MusicXML is one click away: read it, or edit it and apply.');
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

    t.caption('AI tools can suggest edits for you to review, using your own API key.');
    await t.click(id(t, 'panel-ai-tools'), { after: 2600 });
    await t.snap('ai-open');
    await t.click(id(t, 'ai-tool-picker'), { after: 2600 });
    await t.snap('ai-tools-list');
    await t.page.keyboard.press('Escape');
    await t.hold(700);
    await t.click(id(t, 'panel-ai-tools'), { after: 600 });
  },
};
