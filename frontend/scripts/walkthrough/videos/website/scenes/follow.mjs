import { sourceOf, stopWatching } from '../demo/film.mjs';
import { PEOPLE, scrollTo, signIn, visit } from '../site.mjs';
import { WORK } from '../story.mjs';

export default {
  id: 'follow',
  chapter: 'Keep up, and work together',
  async setup(t) {
    await stopWatching(PEOPLE.clara, await sourceOf('dichterliebe', 'grolle'));
    await signIn(t, PEOPLE.clara);
    await visit(t, `/works/${WORK.dichterliebe}`);
  },
  async run(t) {
    const page = t.page;
    const card = page.locator('article').filter({ hasText: 'Ich grolle nicht' }).first();

    await t.caption('Watch a source, and you hear about it when someone changes it.');
    await t.hold(600);
    await t.click(card.getByRole('button', { name: /Watch/ }).first());
    await card.getByText(/Watching \(1\)/).first().waitFor({ state: 'visible', timeout: 30000 });
    await t.hold(1500);
    await t.snap('watching');
    await t.hover(page.getByRole('link', { name: /Notifications/ }).first(), { after: 1500 });

    await t.caption('Projects gather the scores of a bigger effort in one place.');
    await t.click(page.getByRole('link', { name: /Projects/ }).first());
    await page.waitForURL(/\/projects$/);
    await page.getByRole('link', { name: /Dichterliebe, complete/ }).first().waitFor({ state: 'visible' });
    // Past the form for starting a project, to the list of them.
    await scrollTo(t, page.getByRole('link', { name: /Dichterliebe, complete/ }).first(), { offset: 300 });
    await t.hover(page.getByRole('link', { name: /Dichterliebe, complete/ }).first(), { after: 900 });
    await t.click(page.getByRole('link', { name: /Dichterliebe, complete/ }).first());
    await page.waitForURL(/\/projects\/.+/);
    await page.getByRole('heading', { name: 'Dichterliebe, complete' }).waitFor({ state: 'visible' });
    await t.hold(1400);
    await t.snap('project');
    await scrollTo(t, page.getByText('Project Sources').first(), { offset: 110 });
    await t.hold(2200);
    await t.snap('project-sources');
  },
};
