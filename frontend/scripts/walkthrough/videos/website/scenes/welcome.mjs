import { scrollTo, visit } from '../site.mjs';

export default {
  id: 'welcome',
  chapter: 'What it is',
  async setup(t) {
    await visit(t, '/welcome');
  },
  async run(t) {
    const page = t.page;
    await t.caption('Public-domain music as scores you can edit, not just scans to look at.');
    await t.hold(900);
    await t.move(page.getByRole('heading', { level: 1 }), { at: 'bottom' });
    await t.hold(2600);
    await t.snap('hero');

    await t.caption('Find a work, open it in your browser, and share what you improve.');
    await scrollTo(t, page.locator('#how-it-works'), { offset: 150 });
    const steps = page.locator('#how-it-works').locator('xpath=ancestor::section[1]').getByRole('heading', { level: 3 });
    for (let i = 0; i < 3; i++) await t.hover(steps.nth(i), { after: i === 2 ? 900 : 1150 });
    await t.snap('how-it-works');
  },
};
