import path from 'node:path';
import { PEOPLE, scrollTo, signIn, visit } from '../site.mjs';

const ASSETS = path.resolve(import.meta.dirname, '../assets');

/**
 * A real scan: the page goes to the recognition providers configured for the demo stack
 * (start it with `stack.mjs up --scanner`), which takes about a minute and bills GPU time.
 */
export default {
  id: 'scan',
  chapter: 'Scan sheet music',
  async setup(t) {
    await signIn(t, PEOPLE.clara);
    await visit(t, '/scanner');
  },
  async run(t) {
    const page = t.page;

    await t.caption('Only have it on paper? The scanner reads a photo or a PDF of the page.', {
      say: 'Only have it on paper? The scanner reads a photo or a P D F of the page.',
    });
    await t.hold(500);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), t.click(page.locator('#scanner-file'))]);
    await chooser.setFiles(path.join(ASSETS, 'liederkreis-op24-no1-peters.png'));
    await t.hold(700);
    const engines = page.locator('main select');
    await t.hover(engines.nth(0), { after: 300 });
    await engines.nth(0).selectOption({ label: 'HOMR' });
    await t.hold(500);
    await t.hover(engines.nth(1), { after: 300 });
    await engines.nth(1).selectOption({ label: 'Transcoda' });
    await t.hold(900);
    await t.snap('chosen');
    await t.click(page.getByRole('button', { name: 'Select pages' }));
    await page.getByRole('button', { name: 'Start scanning' }).waitFor({ state: 'visible', timeout: 60000 });
    await t.hold(1500);
    await t.snap('pages');

    await t.caption('Two recognition engines read it, each in its own way.');
    await t.click(page.getByRole('button', { name: 'Start scanning' }), { after: 2600 });
    await t.snap('scanning');
    await t.cut(
      async () => {
        await page.getByText(/included pages complete · Succeeded/).waitFor({ state: 'visible', timeout: 600000 });
        await page.waitForTimeout(1200);
      },
      { label: 'Recognition, about a minute: skipped' },
    );
    await scrollTo(t, page.getByText('Recognition providers', { exact: false }).first(), { offset: 150 });
    await t.hold(1800);
    await t.snap('done');

    await t.caption('It shows where it was unsure, and the result opens in the editor to finish by hand.');
    const question = page.getByText(/Base recognition/).first();
    if (await question.isVisible().catch(() => false)) {
      await scrollTo(t, question, { offset: 96 });
      await t.hover(question, { after: 2400 });
      await t.snap('unsure');
      await scrollTo(t, page.getByText('Recognition providers', { exact: false }).first(), { offset: 150 });
    }
    const open = page.getByRole('link', { name: 'Open in Score Editor' }).first();
    await t.hover(open, { after: 500 });
    const editor = await t.followNewTab(() => t.click(open));
    await t.cut(
      async () => {
        await editor.locator('[data-testid="svg-container"] svg .Note').first().waitFor({ state: 'visible', timeout: 180000 });
        await editor.waitForTimeout(1200);
      },
      { label: 'Loading: skipped' },
    );
    await t.hold(3200);
    await t.snap('in-editor');
  },
};
