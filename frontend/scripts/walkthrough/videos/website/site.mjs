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

/** Scrolls the page smoothly by `pixels`, as a reader would. */
export async function scroll(t, pixels, { steps = 12, pause = 28 } = {}) {
  for (let i = 0; i < steps; i++) {
    await t.page.mouse.wheel(0, pixels / steps);
    await t.page.waitForTimeout(t.mode === 'dry' ? 4 : pause);
  }
  await t.hold(250);
}

/** Scrolls so that `locator` sits `offset` pixels below the top of the window. */
export async function scrollTo(t, locator, { offset = 110 } = {}) {
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`scrollTo: nothing to scroll to: ${locator}`);
  await scroll(t, box.y - offset, { steps: Math.max(6, Math.min(26, Math.round(Math.abs(box.y - offset) / 45))) });
}
