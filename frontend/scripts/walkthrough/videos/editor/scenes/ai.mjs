import { id, SCORES, stage } from '../editor.mjs';

/**
 * A real request to the AI assistant. It needs two things the other scenes do not:
 *
 *  - an OpenAI key in WALKTHROUGH_AI_KEY (or OPENAI_API_KEY). The editor is bring-your-own-key:
 *    the key is typed into its panel, exactly as a user would, during `setup`, which is not
 *    recorded. The field is a password field, so the recording shows dots.
 *  - the editor API behind the site's /api/score-editor proxy (see the README).
 *
 * Nothing here may log, save or echo a request: the request body carries the key.
 *
 * The scene stops at the proposal and does not apply it. Applying currently fails on the first
 * try with "The score changed after this proposal was generated": opening the comparison
 * re-lays-out the live score, and the check that guards Apply reads that as an edit.
 */
export const aiKey = () => (process.env.WALKTHROUGH_AI_KEY || process.env.OPENAI_API_KEY || '').trim();

const REQUEST = 'Add a staccato dot to every note in bar 3.';

export default {
  id: 'ai',
  chapter: 'AI assistant',
  async setup(t) {
    if (!aiKey()) throw new Error('the "ai" scene needs WALKTHROUGH_AI_KEY or OPENAI_API_KEY');
    await stage(t, { score: SCORES.ode });
    const page = t.page;
    await id(t, 'panel-ai-tools').click();
    await page.getByPlaceholder('Paste your key').fill(aiKey());
    // The model list loads once a key is present.
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="xml-sidebar"] select')[1]?.options.length > 3, null, { timeout: 30000 });
    await id(t, 'panel-ai-tools').click();
    await page.waitForTimeout(600);
  },
  async run(t) {
    const page = t.page;

    await t.caption('AI tools use your own API key. It is kept in this browser tab, not on the server.', {
      say: 'The A I tools use your own A P I key. It is kept in this browser tab, not on the server.',
    });
    await t.hold(500);
    await t.click(id(t, 'panel-ai-tools'), { after: 2200 });
    await t.snap('panel');
    await t.click(id(t, 'ai-tool-picker'), { after: 2200 });
    await t.snap('tools');
    await page.keyboard.press('Escape');
    await t.hold(500);

    await t.caption('Ask the assistant for a change in plain words.');
    await t.click(page.getByPlaceholder(/Describe the change/));
    await t.text(REQUEST, { delay: 55, after: 900 });
    await t.snap('request');
    await t.click(page.getByRole('button', { name: 'Generate Patch' }), { after: 1400 });
    await t.cut(
      async () => {
        await page.getByRole('button', { name: 'Apply All AI Changes' }).waitFor({ state: 'visible', timeout: 180000 });
        await id(t, 'compare-right-highlight').first().waitFor({ state: 'visible', timeout: 60000 });
        await id(t, 'compare-left-highlight').first().waitFor({ state: 'visible', timeout: 60000 });
        await page.waitForTimeout(900);
      },
      { label: 'Waiting for the model: skipped' },
    );

    await t.caption('It answers with a proposal: the score as it is, next to the score as it would be.');
    await t.hold(2600);
    await t.snap('proposal');
    await t.move(id(t, 'compare-pane-right'));
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 90);
      await t.hold(260);
    }
    await t.hold(900);
    await t.hover(id(t, 'compare-right-highlight').first(), { after: 1600 });
    await t.snap('proposal-scrolled');

    await t.caption('Nothing changes until you accept it: apply a bar, reject it, or send feedback for another try.');
    await t.hover(page.getByRole('button', { name: 'Apply', exact: true }).first(), { after: 1100 });
    await t.hover(page.getByRole('button', { name: 'Reject', exact: true }).first(), { after: 900 });
    await t.hover(page.getByRole('button', { name: 'Comment', exact: true }).first(), { after: 1400 });
    await t.snap('controls');
  },
};
