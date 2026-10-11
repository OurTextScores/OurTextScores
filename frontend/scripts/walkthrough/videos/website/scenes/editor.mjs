import { inReadingOrder } from '../../editor/editor.mjs';
import { visit } from '../site.mjs';
import { WORK } from '../story.mjs';

export default {
  id: 'editor',
  chapter: 'Open it in the editor',
  async setup(t) {
    await visit(t, `/works/${WORK.dichterliebe}`);
  },
  async run(t) {
    const page = t.page;
    const card = page.locator('article').filter({ hasText: 'Ich grolle nicht' }).first();

    await t.caption('Any source opens in the built-in score editor. There is nothing to install.');
    await t.hold(600);
    // The editor opens in a new tab; the recording follows it there.
    await t.hover(card.getByRole('button', { name: /Open Score in Editor/ }), { after: 500 });
    const editor = await t.followNewTab(() => t.click(card.getByRole('button', { name: /Open Score in Editor/ })));
    await t.cut(
      async () => {
        await editor.locator('[data-testid="svg-container"] svg .Note').first().waitFor({ state: 'visible', timeout: 120000 });
        await editor.waitForTimeout(1200);
      },
      { label: 'Loading: skipped' },
    );
    await t.hold(1800);
    await t.snap('opened');

    await t.caption('Change a note, add a marking, fix a rhythm: it is MuseScore’s engine, in the browser.');
    // The vocal line of the first system: the notes level with the topmost one.
    const voiceLine = async () => {
      const notes = await inReadingOrder(t, '.Note');
      const top = Math.min(...notes.map((note) => note.y));
      return notes.filter((note) => note.y - top < 34).sort((a, b) => a.x - b.x);
    };
    // What the page draws, in short: an edit has landed when this changes.
    const drawn = async () =>
      JSON.stringify([(await voiceLine()).map((note) => [Math.round(note.x), Math.round(note.y * 2)]), await editor.locator('[data-testid="svg-container"] svg .Accidental').count()]);
    const press = async (key, after) => {
      const was = await drawn();
      await t.key(key, { after: 0 });
      for (let i = 0; i < 100 && (await drawn()) === was; i++) await editor.waitForTimeout(100);
      if ((await drawn()) === was) throw new Error(`editor scene: ${key} changed nothing`);
      await t.hold(after);
    };
    const note = (await voiceLine())[3];
    await t.click(note, { after: 500 });
    // Step aside, so the pointer does not cover the note that is about to move.
    await t.move({ x: note.x + 46, y: note.y + 44 });
    await t.hold(400);
    await press('ArrowUp', 700);
    await press('ArrowUp', 1100);
    await t.snap('edited');
    await press('Control+z', 500);
    await press('Control+z', 900);
    await t.snap('undone');
  },
};
