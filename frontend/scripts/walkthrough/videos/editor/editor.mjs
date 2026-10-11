/**
 * What the editor scenes share: where the editor is, how a scene gets to a loaded score, and
 * the handful of gestures used throughout.
 */
export const BASE = process.env.WALKTHROUGH_EDITOR_BASE || 'http://localhost:3000/score-editor';
const ORIGIN = new URL(BASE).origin;

export const SCORES = {
  // OpenScore String Quartets, CC0. See assets/README.md.
  faure: `${ORIGIN}/__walkthrough/faure-op121.mxl`,
  // The Ode to Joy theme (Beethoven), entered in the editor and exported: eight bars, and the
  // first phrase alone with four empty bars after it.
  ode: `${ORIGIN}/__walkthrough/ode-to-joy.musicxml`,
  phrase: `${ORIGIN}/__walkthrough/ode-phrase.musicxml`,
};

export const id = (t, testId) => t.page.getByTestId(testId);

/** Opens the editor (optionally on a score) and waits until it can be used. Not for camera. */
export async function openEditor(t, { score = null, query = '' } = {}) {
  // The static embed is a file under /score-editor; a standalone editor server serves it at /.
  const entry = BASE.endsWith('/score-editor') ? `${BASE}/index.html` : `${BASE}/`;
  const url = `${entry}${score ? `?score=${encodeURIComponent(score)}` : ''}${query}`;
  await t.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await id(t, 'shell-header').waitFor({ state: 'visible', timeout: 120000 });
  if (score) await scoreReady(t);
  await t.page.waitForTimeout(900);
}

/** The first page of the score has been engraved and drawn. */
export async function scoreReady(t) {
  await t.page.locator('[data-testid="svg-container"] svg').first().waitFor({ state: 'visible', timeout: 120000 });
  await t.page.waitForTimeout(700);
}

/** Opens a top menu and chooses an item from it, as a user would. */
export async function menu(t, menuName, itemId, { hover = 420 } = {}) {
  await t.click(id(t, `menu-${menuName}`));
  await t.hold(hover);
  await t.click(id(t, `menu-item-${itemId}`));
}

/** How many note heads the drawn page has: a cheap way for a scene to know an edit landed. */
export const noteCount = (t) => t.page.locator('[data-testid="svg-container"] svg .Note').count();

/**
 * Elements on the drawn page in reading order: by system, then left to right. The SVG's own
 * order is the engine's, not the music's. Returns centre points usable as click targets.
 */
export async function inReadingOrder(t, selector = '.Note', { top = -Infinity, bottom = Infinity } = {}) {
  const boxes = await t.page.locator(`[data-testid="svg-container"] svg ${selector}`).evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height };
    }),
  );
  const inBand = boxes.filter((box) => box.y >= top && box.y <= bottom).sort((a, b) => a.y - b.y);
  const systems = [];
  for (const box of inBand) {
    const last = systems.at(-1);
    if (last && box.y - last.bottom < 70) {
      last.items.push(box);
      last.bottom = Math.max(last.bottom, box.y);
    } else {
      systems.push({ items: [box], bottom: box.y });
    }
  }
  return systems.flatMap((system) => system.items.sort((a, b) => a.x - b.x));
}

/** Puts the editor in the state a scene starts from. Not for camera. */
export async function stage(t, { score = null, dock = false, fit = true } = {}) {
  await openEditor(t, { score });
  if (score) {
    // The header shows "Untitled score" until the score's own title has been read.
    await t.page
      .waitForFunction(() => document.querySelector('[data-testid="shell-title"]')?.textContent?.trim() !== 'Untitled score', null, { timeout: 8000 })
      .catch(() => {});
  }
  if (!dock) await id(t, 'btn-dock-close').click();
  if (score && fit) {
    await id(t, 'btn-fit-width').click();
    await t.page.waitForTimeout(900);
  }
}

/** Selects from `first` to `last` (points from `inReadingOrder`): click, then Shift-click. */
export async function selectRange(t, first, last) {
  await t.click(first);
  await t.click(last, { modifiers: ['Shift'] });
}
