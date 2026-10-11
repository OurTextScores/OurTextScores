import { id, scroll, scrollTo, visit } from '../site.mjs';
import { WORK } from '../story.mjs';

export default {
  id: 'work',
  chapter: 'Play and download',
  async setup(t) {
    await visit(t, `/works/${WORK.dichterliebe}`);
    // The preview loads its sounds the first time it plays. Let that happen before filming.
    const preview = t.page.frameLocator('[data-testid="score-preview-frame"]').first();
    await preview.getByRole('button', { name: /^play/i }).first().waitFor({ state: 'visible', timeout: 60000 });
  },
  async run(t) {
    const page = t.page;
    const card = page.locator('article').filter({ hasText: 'Ich grolle nicht' }).first();
    const preview = page.frameLocator('[data-testid="score-preview-frame"]').first();

    await t.caption('A work can hold several sources. Each one is a transcription you can play and edit.');
    await t.hold(700);
    await t.hover(card.getByText('Recommended'), { after: 1700 });
    await t.hover(card.getByText('ADMIN VERIFIED'), { after: 1500 });
    await t.snap('sources');

    await t.caption('Start with the recommended one, and play it right here.');
    await scrollTo(t, page.getByText('Preview score').first(), { offset: 84 });
    await t.hold(500);
    await t.click(preview.getByRole('button', { name: /^play/i }).first(), { after: 300 });
    await t.hold(9500);
    await t.snap('playing');
    await t.click(preview.getByRole('button', { name: /^pause/i }).first(), { after: 500 });

    await t.caption('Or download it: MusicXML, MuseScore or PDF.');
    await scroll(t, -330);
    await t.click(card.locator('summary').filter({ hasText: 'Download' }).first(), { after: 900 });
    await t.hover(card.getByRole('link', { name: 'Download MXL' }), { after: 650 });
    await t.hover(card.getByRole('link', { name: 'Download MSCZ' }), { after: 650 });
    await t.hover(card.getByRole('link', { name: /PDF/ }).first(), { after: 1100 });
    await t.snap('download');
  },
};
