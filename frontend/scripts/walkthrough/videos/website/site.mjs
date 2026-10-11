import { DEMO } from './demo/demo.mjs';
import { signInCookies } from './demo/seed.mjs';

/** Helpers shared by the website scenes. The site filmed is the demo stack (see demo/). */
export const SITE = DEMO.site;
export const PEOPLE = DEMO.people;
export { DEMO };

/** Signs the scene's browser in as a demo person. Do this in `setup`, before the first page. */
export async function signIn(t, person) {
  await t.context.addCookies(await signInCookies(person));
}

/** Opens a page of the site and waits for it to settle. */
export async function visit(t, route, options = {}) {
  await t.goto(`${SITE}${route}`, options);
}

/** A locator by test id. */
export const id = (t, testId) => t.page.getByTestId(testId);

/**
 * Scrolls the page by `pixels`, at the pace of a reader's wheel. The page is scrolled directly
 * rather than with wheel events: a wheel turns whatever is under the pointer, and over an
 * embedded score that is the score, not the page.
 */
export async function scroll(t, pixels, { steps = null, pause = 26 } = {}) {
  const count = steps ?? Math.max(6, Math.min(28, Math.round(Math.abs(pixels) / 42)));
  for (let i = 0; i < count; i++) {
    // Ease in and out, so the page does not lurch.
    const share = (Math.cos((Math.PI * i) / count) - Math.cos((Math.PI * (i + 1)) / count)) / 2;
    // 'instant': the site scrolls smoothly by default, and each smooth step would cancel the last.
    await t.page.evaluate((by) => window.scrollBy({ top: by, behavior: 'instant' }), pixels * share);
    await t.page.waitForTimeout(t.mode === 'dry' ? 4 : pause);
  }
  await t.hold(250);
}

/** Scrolls so that `locator` sits `offset` pixels below the top of the window. */
export async function scrollTo(t, locator, { offset = 110 } = {}) {
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`scrollTo: nothing to scroll to: ${locator}`);
  await scroll(t, box.y - offset);
}

/** The first match of `locator` that is actually shown. Pages keep hidden copies of some text. */
export const shown = (locator) => locator.locator('visible=true').first();

/**
 * Plays a moment of an embedded player and rewinds it. The player fetches its sounds the first
 * time it plays, which takes a few seconds; done off camera, Play then starts at once.
 */
export async function warmUp(t, player) {
  await player.getByTestId('player-play').click();
  await player.getByRole('button', { name: /^pause/i }).first().waitFor({ state: 'visible', timeout: 180000 });
  const seek = player.getByTestId('player-seek');
  for (let i = 0; i < 300 && !(Number(await seek.inputValue()) > 0); i++) await t.page.waitForTimeout(100);
  await player.getByRole('button', { name: 'Stop and rewind' }).click();
  await player.getByRole('button', { name: /^play/i }).first().waitFor({ state: 'visible', timeout: 30000 });
  await t.page.waitForTimeout(500);
}
