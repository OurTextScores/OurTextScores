import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { overlayInit } from './overlay.mjs';

/**
 * The recording stage. The page is laid out at 1280x720 and rendered at 1.5x, so the picture
 * is a true 1920x1080 with a UI large enough to read in a video.
 *
 * The scale has to be set on the browser, not on the Playwright context: with the context's
 * `deviceScaleFactor` the screencast still delivers 1280x720 frames.
 */
export const STAGE = { width: 1280, height: 720, scale: 1.5 };
export const OUTPUT = { width: STAGE.width * STAGE.scale, height: STAGE.height * STAGE.scale, fps: 30 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const epoch = () => Date.now() / 1000;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function launchBrowser() {
  return chromium.launch({
    args: [
      `--force-device-scale-factor=${STAGE.scale}`,
      `--window-size=${STAGE.width},${STAGE.height}`,
      // Playback must be able to start from a scripted click.
      '--autoplay-policy=no-user-gesture-required',
      '--hide-scrollbars',
    ],
  });
}

/**
 * One scene being performed. Scene scripts receive this as `t` and use it instead of the
 * Playwright page for anything the viewer should see, so that the pointer glides, clicks
 * ripple, and every action lands on the timeline captions are attached to.
 */
export class Take {
  constructor({ page, context, dir, mode, speed, narration = null }) {
    this.page = page;
    this.context = context;
    this.dir = dir;
    this.mode = mode; // 'record' | 'dry'
    this.speed = speed; // dry runs can go faster than a viewer could follow
    this.narration = narration; // knows how long each caption takes to say
    this.cutSeconds = 0;
    this.mouse = { x: STAGE.width * 0.62, y: STAGE.height * 0.55 };
    this.frames = [];
    this.pendingWrites = [];
    this.events = { beats: [], captions: [], cuts: [] };
    this.startedAt = null;
    this.snapIndex = 0;
    this.problems = [];
  }

  // ------------------------------------------------------------------ timeline
  /** Seconds since recording started. */
  at() {
    return this.startedAt === null ? 0 : epoch() - this.startedAt;
  }

  beat(name) {
    this.events.beats.push({ name, at: epoch() });
    if (process.env.WALKTHROUGH_VERBOSE) console.log(`    ${this.at().toFixed(2)}s  ${name}`);
  }

  /**
   * Shows `text` from now until the next caption, `endCaption()`, or the end of the scene.
   * `say` is what the narrator says, where that should differ from what is written ("Ctrl+S"
   * is read as "Control S").
   *
   * A caption is never replaced before its line could have been spoken: starting the next one
   * first waits out whatever is left of this one. Scenes are thereby paced by their narration,
   * and the same takes serve the version with a voice and the one without.
   */
  async caption(text, { position = 'bottom', say = null } = {}) {
    await this.endCaption();
    if (text) {
      this.events.captions.push({ text, say: say ?? text, position, start: epoch(), end: null, cutAtStart: this.cutSeconds });
    }
  }

  async endCaption() {
    const open = this.events.captions.at(-1);
    if (!open || open.end !== null) return;
    if (this.narration && this.mode === 'record') {
      const shown = epoch() - open.start - (this.cutSeconds - open.cutAtStart);
      const needed = this.narration.secondsFor(open.say);
      if (shown < needed) await sleep((needed - shown) * 1000);
    }
    open.end = epoch();
  }

  /**
   * Runs `fn` and removes the time it took from the video: a file converting, an engine
   * starting. With a `label`, the edit shows it briefly so the cut is not silent.
   */
  async cut(fn, { label = null } = {}) {
    const start = epoch();
    try {
      return await fn();
    } finally {
      const end = epoch();
      this.cutSeconds += end - start;
      this.events.cuts.push({ start, end, label });
    }
  }

  async hold(ms) {
    await sleep(this.mode === 'dry' ? ms * this.speed : ms);
  }

  // ------------------------------------------------------------------ pointer
  async point(target, { offset = null, at = 'center' } = {}) {
    if (typeof target.x === 'number') return { x: target.x, y: target.y };
    await target.scrollIntoViewIfNeeded({ timeout: 15000 }).catch(() => {});
    const box = await target.boundingBox({ timeout: 15000 });
    if (!box) throw new Error(`walkthrough: target has no box: ${target}`);
    const anchors = {
      center: [0.5, 0.5],
      left: [0.12, 0.5],
      right: [0.88, 0.5],
      top: [0.5, 0.2],
      bottom: [0.5, 0.8],
    };
    const [ax, ay] = anchors[at] ?? anchors.center;
    return {
      x: box.x + box.width * ax + (offset?.x ?? 0),
      y: box.y + box.height * ay + (offset?.y ?? 0),
    };
  }

  /** Glides the pointer to `target` (a locator or a point), as a hand would. */
  async move(target, { duration = null, ...where } = {}) {
    const to = await this.point(target, where);
    const from = { ...this.mouse };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (distance < 1.5) return to;
    const ms = (duration ?? Math.min(900, Math.max(260, 220 + distance * 0.9))) * (this.mode === 'dry' ? this.speed : 1);
    // A slight arc: straight lines read as a machine.
    const bend = Math.min(40, distance * 0.08);
    const normal = { x: -(to.y - from.y) / distance, y: (to.x - from.x) / distance };
    const steps = Math.max(2, Math.round(ms / 16));
    const started = Date.now();
    for (let i = 1; i <= steps; i++) {
      const p = easeInOut(i / steps);
      const arc = Math.sin(Math.PI * p) * bend;
      const x = from.x + (to.x - from.x) * p + normal.x * arc;
      const y = from.y + (to.y - from.y) * p + normal.y * arc;
      await this.page.mouse.move(x, y);
      const due = started + (ms * i) / steps;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.mouse = to;
    return to;
  }

  async click(target, { button = 'left', count = 1, modifiers = [], dwell = 140, after = 260, ...where } = {}) {
    await this.move(target, where);
    await this.hold(dwell);
    for (const key of modifiers) await this.page.keyboard.down(key);
    for (let i = 1; i <= count; i++) {
      await this.page.mouse.down({ button, clickCount: i });
      await sleep(70);
      await this.page.mouse.up({ button, clickCount: i });
      if (i < count) await sleep(90);
    }
    for (const key of [...modifiers].reverse()) await this.page.keyboard.up(key);
    await this.hold(after);
  }

  async hover(target, { after = 350, ...where } = {}) {
    await this.move(target, where);
    await this.hold(after);
  }

  async drag(from, to, { duration = 900, hold = 220, fromWhere = {}, toWhere = {} } = {}) {
    await this.move(from, fromWhere);
    await this.hold(160);
    await this.page.mouse.down();
    await this.hold(hold);
    await this.move(to, { duration, ...toWhere });
    await this.hold(hold);
    await this.page.mouse.up();
    await this.hold(260);
  }

  // ------------------------------------------------------------------ keyboard
  /** Presses a key or chord ("n", "Shift+ArrowRight", "Control+z"). The badge shows it. */
  async key(combo, { times = 1, gap = 200, after = 260 } = {}) {
    for (let i = 0; i < times; i++) {
      await this.page.keyboard.press(combo);
      if (i < times - 1) await this.hold(gap);
    }
    await this.hold(after);
  }

  async keys(list, { gap = 300, after = 300 } = {}) {
    for (let i = 0; i < list.length; i++) {
      await this.page.keyboard.press(list[i]);
      if (i < list.length - 1) await this.hold(gap);
    }
    await this.hold(after);
  }

  /** Types into the focused field. No key badges: they would only repeat the text. */
  async text(value, { delay = 60, after = 300 } = {}) {
    await this.page.evaluate(() => {
      window.__wt.keysEnabled = false;
    });
    await this.page.keyboard.type(value, { delay: this.mode === 'dry' ? 5 : delay });
    await this.page.evaluate(() => {
      window.__wt.keysEnabled = true;
    });
    await this.hold(after);
  }

  /** Clicks a field and replaces what is in it. */
  async replaceText(target, value, options = {}) {
    await this.click(target);
    await this.page.evaluate(() => {
      window.__wt.keysEnabled = false;
    });
    await this.page.keyboard.press('Control+a');
    await this.text(value, options);
  }

  // ------------------------------------------------------------------ emphasis
  async callout(target, label = '', { pad = 6, dim = false, place = 'below' } = {}) {
    const box = typeof target.x === 'number' ? target : await target.boundingBox();
    if (!box) return;
    await this.page.evaluate((args) => window.__wt.callout(args), { ...box, label, pad, dim, place });
  }

  async clearCallout() {
    await this.page.evaluate(() => window.__wt.clearCallout());
  }

  // ------------------------------------------------------------------ dry runs
  /** In a dry run, saves a screenshot so the scene can be checked without recording it. */
  async snap(name) {
    if (this.mode !== 'dry') return;
    const file = path.join(this.dir, 'snaps', `${String(++this.snapIndex).padStart(2, '0')}-${name}.png`);
    mkdirSync(path.dirname(file), { recursive: true });
    await this.page.screenshot({ path: file });
  }

  // ------------------------------------------------------------------ navigation
  /**
   * Goes to `url` as if a link had been followed, and waits for the page to settle. The
   * pointer is drawn again where it was.
   */
  async goto(url, { waitUntil = 'networkidle', settle = 250 } = {}) {
    await this.drainAudio(); // the sound this document made leaves with it
    await this.page.goto(url, { waitUntil, timeout: 60000 });
    await this.arrived({ settle });
  }

  /**
   * Call after anything that loads a new document (a form post, a plain link): a new document
   * starts without the overlay, so the pointer would vanish until the next scripted move.
   * In-app navigation keeps the document and needs nothing.
   */
  async arrived({ settle = 250 } = {}) {
    await this.page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    await this.page.waitForTimeout(settle);
    if (this.overlayOn) await this.installOverlay();
  }

  /**
   * Films another tab from here on: the one a link opened, or the first one again. The viewer
   * sees what they would see when the browser brings that tab to the front.
   */
  async switchTo(page) {
    if (page === this.page) return;
    await this.drainAudio();
    await this.cdp?.send('Page.stopScreencast').catch(() => {});
    this.page = page;
    await page.bringToFront().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (this.mode === 'record' && this.startedAt !== null) await this.startScreencast();
    if (this.overlayOn) await this.installOverlay();
  }

  /** Runs `action` (a click that opens a new tab) and films the new tab once it is there. */
  async followNewTab(action) {
    const [opened] = await Promise.all([this.context.waitForEvent('page', { timeout: 30000 }), action()]);
    await this.switchTo(opened);
    return opened;
  }

  // ------------------------------------------------------------------ internals
  async installOverlay() {
    this.overlayOn = true;
    await this.page.evaluate(() => window.__wt?.install());
    // Make the pointer appear where the scene will start from.
    await this.page.mouse.move(this.mouse.x - 2, this.mouse.y - 2);
    await this.page.mouse.move(this.mouse.x, this.mouse.y);
  }

  async startRecording() {
    // Sound made while setting the scene up is not part of it.
    for (const frame of this.page.frames()) {
      await frame.evaluate(() => window.__wt?.drainAudio && void (window.__wt.audioChunks.length = 0)).catch(() => {});
    }
    this.audioChunks = [];
    this.startedAt = epoch();
    // Sound is collected as the scene goes, not at its end: a page that is navigated away from
    // takes what it captured with it.
    this.audioTimer = setInterval(() => this.drainAudio().catch(() => {}), 300);
    if (this.mode !== 'record') return;
    await this.startScreencast();
  }

  /** Films `this.page`. Frames from every page filmed in a take go to the one list, in order. */
  async startScreencast() {
    const framesDir = path.join(this.dir, 'frames');
    mkdirSync(framesDir, { recursive: true });
    const cdp = (this.cdp = await this.context.newCDPSession(this.page));
    cdp.on('Page.screencastFrame', (event) => {
      cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      if (cdp !== this.cdp) return; // a page that is no longer the one being filmed
      const file = path.join(framesDir, `${String(this.frames.length).padStart(6, '0')}.jpg`);
      this.frames.push({ file, at: event.metadata.timestamp });
      this.pendingWrites.push(writeFile(file, Buffer.from(event.data, 'base64')));
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 95,
      everyNthFrame: 1,
      maxWidth: OUTPUT.width,
      maxHeight: OUTPUT.height,
    });
    // The screencast only sends a frame when the picture changes; nudge one out so the
    // picture starts with a frame at its start time.
    await this.page.mouse.move(this.mouse.x + 1, this.mouse.y);
    await this.page.mouse.move(this.mouse.x, this.mouse.y);
  }

  /**
   * Writes what the page's audio tap captured as a WAV on the scene's own clock: sample 0 is
   * the moment recording started. The tap sends runs of sound stamped with both the audio
   * context's time and the wall clock; within one unbroken run of the context ("period") the
   * two differ by a constant, which is estimated once per period and then used to place every
   * run. Silence, including the time the context spent suspended, is simply left empty.
   */
  /** Moves what the page's audio tap has captured so far over to the recorder. */
  drainAudio() {
    this.draining = (this.draining ?? Promise.resolve()).then(async () => {
      if (!this.audioChunks) return;
      for (const frame of this.context.pages().flatMap((page) => page.frames())) {
        for (;;) {
          const batch = await frame
            .evaluate(() => (window.__wt?.drainAudio ? window.__wt.drainAudio(40) : []))
            .catch(() => []);
          if (batch.length === 0) break;
          for (const chunk of batch) this.audioChunks.push({ ...chunk, key: chunk.run });
        }
      }
    });
    return this.draining;
  }

  async collectAudio(endedAt) {
    clearInterval(this.audioTimer);
    await this.drainAudio();
    const chunks = this.audioChunks ?? [];
    if (chunks.length === 0) return [];

    const offsets = new Map();
    for (const chunk of chunks) {
      if (!offsets.has(chunk.key)) offsets.set(chunk.key, []);
      offsets.get(chunk.key).push(chunk.wallMs - chunk.contextTime * 1000);
    }
    for (const [key, values] of offsets) {
      values.sort((a, b) => a - b);
      offsets.set(key, values[Math.floor(values.length / 2)]);
    }

    const recordings = [];
    for (const rate of new Set(chunks.map((chunk) => chunk.sampleRate))) {
      const frames = Math.ceil((endedAt - this.startedAt + 0.25) * rate);
      const mix = new Float32Array(frames * 2);
      let placed = 0;
      for (const chunk of chunks.filter((c) => c.sampleRate === rate)) {
        const bytes = Buffer.from(chunk.base64, 'base64');
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
        const startSeconds = (chunk.contextTime * 1000 + offsets.get(chunk.key)) / 1000 - this.startedAt;
        const first = Math.round(startSeconds * rate);
        for (let i = 0; i < pcm.length / 2; i++) {
          const at = first + i;
          if (at < 0 || at >= frames) continue;
          mix[at * 2] += pcm[i * 2] / 32768;
          mix[at * 2 + 1] += pcm[i * 2 + 1] / 32768;
          placed++;
        }
      }
      if (placed === 0) continue;
      const data = Buffer.alloc(mix.length * 2);
      for (let i = 0; i < mix.length; i++) {
        data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767))), i * 2);
      }
      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + data.length, 4);
      header.write('WAVEfmt ', 8);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20); // PCM
      header.writeUInt16LE(2, 22); // stereo
      header.writeUInt32LE(rate, 24);
      header.writeUInt32LE(rate * 4, 28);
      header.writeUInt16LE(4, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(data.length, 40);
      const file = path.join(this.dir, `audio-${recordings.length}.wav`);
      writeFileSync(file, Buffer.concat([header, data]));
      recordings.push({ file, startedAt: this.startedAt, soundSeconds: +(placed / rate).toFixed(2), periods: offsets.size });
    }
    return recordings;
  }

  async stopRecording() {
    await this.endCaption();
    const endedAt = epoch();
    if (this.mode === 'record') {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      await Promise.all(this.pendingWrites);
    }
    const audio = await this.collectAudio(endedAt);
    const take = {
      startedAt: this.startedAt,
      endedAt,
      frames: this.frames,
      audio,
      ...this.events,
      problems: this.problems,
    };
    writeFileSync(path.join(this.dir, 'take.json'), JSON.stringify(take));
    return take;
  }
}

/**
 * Performs one scene in a fresh browser context and writes the take to `dir`.
 *
 * A scene is `{ id, chapter, setup?(t), run(t) }`. `setup` prepares the state the scene
 * starts from and is not recorded.
 */
export async function performScene(browser, scene, { dir, mode = 'record', speed = 0.25, assetsDir, hooks = {}, narration = null }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: null, acceptDownloads: true });
  await context.addInitScript(overlayInit, { audio: true, keyBadgeMs: 1100 });
  if (assetsDir) {
    // Scene assets are served as if they were part of the site being recorded, so scores
    // load same-origin with no extra server: <origin>/__walkthrough/<file>.
    await context.route('**/__walkthrough/**', (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/__walkthrough/')[1]);
      try {
        route.fulfill({ status: 200, body: readFileSync(path.join(assetsDir, name)) });
      } catch {
        route.fulfill({ status: 404, body: 'not found' });
      }
    });
  }
  let take = null;
  const watch = (page) => {
    page.on('pageerror', (error) => take?.problems.push(`pageerror: ${String(error).slice(0, 300)}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
        take?.problems.push(`console: ${message.text().slice(0, 300)}`);
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400) take?.problems.push(`http ${response.status()}: ${response.url().slice(0, 200)}`);
    });
    // A document loaded mid-scene (a link that is not in-app navigation) starts without the
    // overlay. Put it back once the page has had its first render, so that a scene does not
    // have to know which of its clicks loads a new document.
    page.on('load', () => {
      if (!take?.overlayOn || take.page !== page) return;
      setTimeout(() => take.installOverlay().catch(() => {}), 200);
    });
  };
  context.on('page', watch);
  const page = await context.newPage();
  take = new Take({ page, context, dir, mode, speed, narration });
  try {
    await hooks.beforeScene?.(take, scene);
    await scene.setup?.(take);
    await take.installOverlay();
    await take.startRecording();
    await take.hold(350);
    await scene.run(take);
    await take.hold(450);
    return await take.stopRecording();
  } catch (error) {
    await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    clearInterval(take.audioTimer);
    await context.close();
  }
}
