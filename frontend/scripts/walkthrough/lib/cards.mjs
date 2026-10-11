import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { OUTPUT } from './recorder.mjs';

/**
 * Everything drawn on top of, or between, the recordings: title and end cards, captions and
 * the small "trimmed" labels. Each is a piece of HTML rendered to a PNG by the browser, so the
 * type is as sharp as the UI in the recording and nothing depends on ffmpeg's text rendering.
 */
const FONT = `"Geist", "Ubuntu Sans", "Lato", "Segoe UI", system-ui, sans-serif`;
const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const page = (body, extraCss = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  body { width: ${OUTPUT.width}px; height: ${OUTPUT.height}px; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
  ${extraCss}
</style></head><body>${body}</body></html>`;

export class CardRenderer {
  static async open() {
    const renderer = new CardRenderer();
    renderer.browser = await chromium.launch();
    renderer.context = await renderer.browser.newContext({
      viewport: { width: OUTPUT.width, height: OUTPUT.height },
      deviceScaleFactor: 1,
    });
    renderer.page = await renderer.context.newPage();
    return renderer;
  }

  async close() {
    await this.browser.close();
  }

  /** Renders `selector` (or the whole frame) and returns where it sits in the frame. */
  async render(html, file, selector = null) {
    mkdirSync(path.dirname(file), { recursive: true });
    await this.page.setContent(html, { waitUntil: 'load' });
    await this.page.evaluate(() => document.fonts.ready);
    if (!selector) {
      await this.page.screenshot({ path: file, omitBackground: true });
      return { file, x: 0, y: 0, width: OUTPUT.width, height: OUTPUT.height };
    }
    const element = this.page.locator(selector);
    const box = await element.boundingBox();
    await element.screenshot({ path: file, omitBackground: true });
    return { file, x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  }

  /** A caption: one or two lines in a dark pill, low in the frame (or high, to stay off what it describes). */
  caption(text, file, { position = 'bottom' } = {}) {
    // 'bottom' clears the app's status bar; 'low' sits on it, for when a dialog reaches down
    // to where the caption would be; 'top' is just under the editor's toolbar; 'high' is just
    // under a site's header, for when the controls being shown are at the foot of the page.
    const edge = { top: 'top: 280px', high: 'top: 128px', low: 'bottom: 10px' }[position] ?? 'bottom: 96px';
    return this.render(
      page(
        `<div class="wrap"><div class="shot"><div class="caption">${escapeHtml(text)}</div></div></div>`,
        `.wrap { position: absolute; left: 0; right: 0; ${edge}; display: flex; justify-content: center; margin: -40px 0; }
         .shot { padding: 40px; }
         .caption { max-width: 1320px; padding: 16px 30px 18px; border-radius: 16px; background: rgba(15,23,42,.9);
                    color: #f8fafc; font-size: 35px; line-height: 1.32; font-weight: 500; text-align: center;
                    letter-spacing: .005em; box-shadow: 0 10px 30px rgba(2,6,23,.35); text-wrap: balance; }`,
      ),
      file,
      // The padded wrapper, not the pill: cut at the pill's own box, the corners outside its
      // rounding would keep a square of its shadow.
      '.shot',
    );
  }

  /** Shown for a moment where waiting time was removed, so the cut is not silent. */
  cutLabel(text, file) {
    return this.render(
      page(
        `<div class="shot"><div class="label">⏩ ${escapeHtml(text)}</div></div>`,
        `.shot { position: absolute; right: 6px; top: 120px; padding: 30px; }
         .label { padding: 10px 18px; border-radius: 999px;
                  background: rgba(5,150,105,.95); color: #fff; font-size: 24px; font-weight: 600;
                  box-shadow: 0 8px 24px rgba(2,6,23,.3); }`,
      ),
      file,
      '.shot',
    );
  }

  /** A full-frame card. `lines` are smaller lines under the title. */
  card({ title, subtitle = '', lines = [], logo = null, footer = '' }, file) {
    const logoMarkup = logo
      ? `<img class="logo" src="data:image/svg+xml;base64,${readFileSync(logo).toString('base64')}" alt="">`
      : '';
    return this.render(
      page(
        `<div class="card">
           ${logoMarkup}
           <h1>${escapeHtml(title)}</h1>
           ${subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : ''}
           ${lines.length ? `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : ''}
           ${footer ? `<p class="footer">${escapeHtml(footer)}</p>` : ''}
         </div>`,
        `body { background: radial-gradient(1200px 700px at 22% 18%, #0f766e 0%, rgba(15,118,110,0) 60%),
                            radial-gradient(1100px 800px at 85% 90%, #1d4ed8 0%, rgba(29,78,216,0) 55%), #0b1220; }
         .card { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center;
                 padding: 0 190px; color: #f8fafc; }
         .logo { width: 150px; height: 150px; margin-bottom: 44px; background: #f8fafc; border-radius: 50%; padding: 10px; }
         h1 { margin: 0; font-size: 108px; line-height: 1.04; font-weight: 700; letter-spacing: -.02em; }
         .sub { margin: 30px 0 0; font-size: 46px; line-height: 1.25; color: #cbd5e1; font-weight: 400; max-width: 1300px; }
         ul { margin: 54px 0 0; padding: 0; list-style: none; font-size: 36px; line-height: 1.7; color: #e2e8f0; }
         .footer { position: absolute; left: 190px; right: 190px; bottom: 70px; margin: 0; font-size: 24px;
                   line-height: 1.5; color: #94a3b8; }`,
      ),
      file,
    );
  }
}
