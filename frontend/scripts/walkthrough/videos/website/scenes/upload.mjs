import path from 'node:path';
import { emptyWork } from '../demo/film.mjs';
import { entry } from '../demo/catalogue.mjs';
import { DEMO, PEOPLE, scrollTo, visit } from '../site.mjs';

const ASSETS = path.resolve(import.meta.dirname, '../assets');
const BRAHMS = entry('brahms-op49');

async function mailedLink(person) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const list = await (await fetch(`${DEMO.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${person.email}`)}&limit=1`)).json();
    const latest = list.messages?.[0];
    if (latest && Date.now() - new Date(latest.Created).getTime() < 20000) {
      const body = await (await fetch(`${DEMO.mailpit}/api/v1/message/${latest.ID}`)).json();
      const match = (body.Text || '').match(/(http\S+\/api\/auth\/callback\/email\S*)/);
      if (match) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('no sign-in mail arrived');
}

export default {
  id: 'upload',
  chapter: 'Add a score',
  async setup(t) {
    await emptyWork('brahms-op49');
    await visit(t, '/signin');
  },
  async run(t) {
    const page = t.page;
    const clara = PEOPLE.clara;

    await t.caption('To add a score of your own, sign in. A link by email is all it takes.');
    await t.click(page.locator('input[type="email"]'), { after: 300 });
    await t.text(clara.email, { delay: 38, after: 500 });
    await t.click(page.getByRole('button', { name: 'Email me a sign-in link' }), { after: 1500 });
    await t.snap('link-sent');
    await t.cut(
      async () => {
        // The demo's mail goes to its own mailbox; this is the link Clara would click there.
        await page.goto(await mailedLink(clara), { waitUntil: 'networkidle' });
        await page.goto(`${DEMO.site}/works/upload`, { waitUntil: 'networkidle' });
        await t.arrived();
      },
      { label: 'Opening the link in the email: skipped' },
    );
    await t.hold(700);

    await t.caption('Start from the work’s page on IMSLP.', { say: 'Start from the work’s page on I M S L P.' });
    await t.click(page.getByPlaceholder('https://imslp.org/wiki/...'), { after: 300 });
    await t.text(BRAHMS.imslp, { delay: 14, after: 600 });
    await t.click(page.getByRole('button', { name: /Save work/ }));
    await t.cut(() => page.getByText(/is ready for uploads/).waitFor({ state: 'visible', timeout: 120000 }), { label: 'Looking the work up: skipped' });
    await t.hold(1500);
    await t.snap('work-saved');
    await t.click(page.getByRole('link', { name: /View work detail/ }));
    await page.waitForURL(/\/works\/\d+$/);
    await page.getByRole('heading', { name: '5 Lieder' }).waitFor({ state: 'visible' });
    await t.hold(900);

    await t.caption('Then upload your file, give it a title and choose a licence.');
    const form = page.locator('details').filter({ hasText: 'Add a source' }).first();
    await scrollTo(t, form, { offset: 96 });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), t.click(form.getByRole('button', { name: /Upload Source/ }))]);
    await chooser.setFiles({
      name: 'Wiegenlied.mscz',
      mimeType: 'application/vnd.musescore.mscz',
      buffer: (await import('node:fs')).readFileSync(path.join(ASSETS, 'brahms-op49-4-wiegenlied.mscz')),
    });
    await t.hold(700);
    await t.click(form.getByPlaceholder('Source Title (optional)'), { after: 250 });
    await t.text('Wiegenlied', { delay: 55, after: 400 });
    await t.hover(form.locator('select').first(), { after: 350 });
    await form.locator('select').first().selectOption('CC0');
    await t.hold(900);
    await t.snap('form-filled');
    await t.click(form.getByRole('button', { name: /Upload new source/ }), { after: 1600 });
    await t.snap('uploading');

    await t.caption('The site converts it, and prepares the other formats for download.');
    const card = page.locator('article').filter({ hasText: 'Wiegenlied' }).first();
    await t.cut(
      async () => {
        await card.waitFor({ state: 'visible', timeout: 300000 });
        await page.frameLocator('[data-testid="score-preview-frame"]').first().locator('svg .Note').first().waitFor({ state: 'visible', timeout: 180000 });
        await page.waitForTimeout(800);
      },
      { label: 'Converting: skipped' },
    );
    await scrollTo(t, card, { offset: 84 });
    await t.hold(1200);
    await t.snap('uploaded');
    await t.click(card.locator('summary').filter({ hasText: 'Download' }).first(), { after: 1500 });
    await t.snap('formats');
    await t.hold(900);
  },
};
