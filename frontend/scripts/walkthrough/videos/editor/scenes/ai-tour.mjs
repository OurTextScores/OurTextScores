import { id, SCORES, stage } from '../editor.mjs';

/** The AI panel without a request: what the video shows when no API key is available for `ai`. */
export default {
  id: 'ai-tour',
  chapter: 'AI tools',
  async setup(t) {
    await stage(t, { score: SCORES.ode });
  },
  async run(t) {
    await t.caption('AI tools can suggest edits for you to review, using your own API key.', {
      say: 'The A I tools can suggest edits for you to review, using your own A P I key.',
    });
    await t.hold(500);
    await t.click(id(t, 'panel-ai-tools'), { after: 2600 });
    await t.snap('ai-open');
    await t.click(id(t, 'ai-tool-picker'), { after: 2600 });
    await t.snap('ai-tools-list');
    await t.page.keyboard.press('Escape');
    await t.hold(700);
    await t.click(id(t, 'panel-ai-tools'), { after: 600 });
  },
};
