import { seededReview } from '../demo/film.mjs';
import { PEOPLE, scroll, scrollTo, shown, signIn, visit } from '../site.mjs';

const REPLY = 'That reads well now. Thank you!';

export default {
  id: 'review',
  chapter: 'Improve it together',
  async setup(t) {
    t.review = await seededReview({ tidyFor: PEOPLE.clara });
    await signIn(t, PEOPLE.clara);
    await visit(t, '/change-reviews');
  },
  async run(t) {
    const page = t.page;

    await t.caption('Every source keeps its history, and a change can be proposed on a branch.');
    await t.hold(700);
    await t.hover(page.getByRole('link', { name: /Editorial dynamics/ }).first(), { after: 1500 });
    await t.snap('list');
    await t.click(page.getByRole('link', { name: 'Open Review' }).first());
    await page.waitForURL(/\/change-reviews\/.+/);
    await page.getByRole('button', { name: /Round 1/ }).waitFor({ state: 'visible', timeout: 60000 });
    await t.hold(1600);
    await t.snap('review-top');

    await t.caption('A change review puts the two versions side by side, with the changed bars marked.');
    await t.click(page.getByRole('button', { name: /Round 1/ }), { after: 400 });
    // The side-by-side view is the score editor's compare view, embedded in the page.
    const compare = page.frameLocator('iframe[src*="score-editor"]').first();
    await t.cut(
      async () => {
        await page.getByText(/Rev #1 vs Rev #2/).first().waitFor({ state: 'visible', timeout: 120000 });
        await compare.getByText(/Is this p in the first edition/).first().waitFor({ state: 'visible', timeout: 180000 });
        await page.waitForTimeout(1500);
      },
      { label: 'Loading: skipped' },
    );
    await scrollTo(t, page.getByText('Review score').first(), { offset: 84 });
    await scroll(t, 375);
    await t.hold(2600);
    await t.snap('round-1');

    await t.caption('Discuss a change right where it is, round after round, until it is settled.');
    const question = compare.getByText(/Is this p in the first edition/).first();
    await t.hover(question, { after: 2000 });
    await t.hover(compare.getByText(/Editorial\. I have changed it/).first(), { after: 1700 });
    await t.click(compare.getByRole('button', { name: 'Reply' }).first(), { after: 500 });
    // Into the box, not at the score beside it: there, letters are editor shortcuts.
    await t.click(compare.getByPlaceholder('Write a reply'), { after: 250 });
    await t.text(REPLY, { delay: 42, after: 600 });
    await t.snap('typed');
    await t.click(compare.getByRole('button', { name: 'Reply', exact: true }).first(), { after: 300 });
    await compare.getByText(REPLY).first().waitFor({ state: 'visible', timeout: 30000 });
    await t.hold(1500);
    await t.snap('replied');

    // The second round: what changed after the question.
    await scrollTo(t, page.getByRole('button', { name: /Round 2/ }), { offset: 140 });
    await t.click(page.getByRole('button', { name: /Round 2/ }), { after: 400 });
    await t.cut(
      async () => {
        await page.getByText(/Rev #2 vs Rev #3/).first().waitFor({ state: 'visible', timeout: 120000 });
        await compare.getByText(/Voice - m\. 5/).first().waitFor({ state: 'visible', timeout: 180000 });
        await page.waitForTimeout(1500);
      },
      { label: 'Loading: skipped' },
    );
    await scrollTo(t, page.getByText('Review score').first(), { offset: 84 });
    await scroll(t, 375);
    await t.hold(2600);
    await t.snap('round-2');
  },
};
