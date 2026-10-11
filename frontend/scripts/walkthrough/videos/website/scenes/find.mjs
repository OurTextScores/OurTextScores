import { scroll, visit } from '../site.mjs';

export default {
  id: 'find',
  chapter: 'Find a work',
  async setup(t) {
    await visit(t, '/welcome');
  },
  async run(t) {
    const page = t.page;
    await t.caption('Search by title, composer or catalogue number.');
    await t.click(page.getByPlaceholder(/Search by title/), { after: 400 });
    await t.text('Schumann', { delay: 85, after: 700 });
    await t.snap('typed');
    await t.click(page.getByRole('button', { name: 'Search', exact: true }));
    await page.waitForURL(/\/catalogue/);
    await page.getByRole('link', { name: 'Dichterliebe' }).first().waitFor({ state: 'visible' });
    await t.hold(1900);
    await t.snap('results');

    await t.caption('Every work is tied to its page on IMSLP, the library of public-domain scores.', {
      say: 'Every work is tied to its page on I M S L P, the library of public-domain scores.',
    });
    await t.click(page.getByRole('link', { name: 'Dichterliebe' }).first());
    await page.waitForURL(/\/works\//);
    await page.getByRole('heading', { name: 'Dichterliebe' }).waitFor({ state: 'visible' });
    await t.hold(900);
    await t.hover(page.getByRole('link', { name: /View on IMSLP/ }), { after: 2400 });
    await t.snap('work');
    await scroll(t, 0);
  },
};
