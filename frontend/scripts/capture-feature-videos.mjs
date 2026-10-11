#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { encode } from 'next-auth/jwt';

const BASE = 'http://localhost:3000';
const PROD = 'https://www.ourtextscores.com'; // apex 307s to www; public example content lives here
const OUT = resolve(import.meta.dirname, '../public/images/features');
const TMP = resolve(import.meta.dirname, '../.video-tmp');
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

// Local work with several sources (the public example, 1148359, exists only on prod).
// Recorded locally so the video shows the current work-page design.
const WORK_ID = process.env.FEATURE_WORK_ID || '659298';
const SCANNER_JOB_ID = 'ef98b123-329e-4ae7-a01f-cf15059b354b';
const REVIEW_ID = 'f8fce149-4c91-488a-8516-e051d9868f30';
const FAURE_SCORE_URL = 'https://raw.githubusercontent.com/OpenScore/StringQuartets/refs/heads/main/scores/Faur%C3%A9,_Gabriel/String_Quartet,_Op.121/sq7358708.mxl';
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'dev-secret';
const USER_EMAIL = 'jhlusko@gmail.com';
const USER_SUB = '69a0e95ce53be0fd8f60b812';

async function generateSessionCookie() {
  const token = await encode({
    token: { email: USER_EMAIL, name: 'Test', sub: USER_SUB },
    secret: NEXTAUTH_SECRET,
  });
  return {
    name: 'next-auth.session-token',
    value: token,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  };
}

function processVideo(srcPath, destPath, { trimStart = 0, width = 1280 } = {}) {
  const ssArg = trimStart > 0 ? `-ss ${trimStart}` : '';
  const cmd = `${JSON.stringify(FFMPEG_BIN)} -y ${ssArg} -i "${srcPath}" -vf "scale=${width}:-2" -an -c:v libvpx -b:v 600k -crf 25 "${destPath}"`;
  execSync(cmd, { stdio: 'pipe' });
}

async function recordScenario(browser, sessionCookie, { name, darkMode, interact, trimStart = 0, anonymous = false }) {
  const suffix = darkMode ? 'dark' : 'light';
  const videoDir = resolve(TMP, `${name}-${suffix}`);
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: darkMode ? 'dark' : 'light',
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  // `anonymous` records what a first-time visitor sees (no admin buttons).
  if (!anonymous) await context.addCookies([sessionCookie]);
  if (darkMode) {
    await context.addInitScript(() => { localStorage.setItem('theme', 'dark'); });
  } else {
    await context.addInitScript(() => { localStorage.setItem('theme', 'light'); });
  }

  const page = await context.newPage();
  let interactionResult;
  try {
    interactionResult = await interact(page);
  } catch (err) {
    console.error(`  ERROR in ${name}-${suffix}:`, err.message);
  }

  await page.close();
  const rawVideoPath = await page.video().path();
  await context.close();

  const outPath = `${OUT}/${name}-${suffix}.webm`;
  processVideo(rawVideoPath, outPath, {
    trimStart: interactionResult?.trimStart ?? trimStart,
  });
  console.log(`  captured ${name}-${suffix}.webm`);

  try { unlinkSync(rawVideoPath); } catch {}
}

// ── Scenario: Versioned Sources — recommended source, preview, downloads, other sources ──
async function versionedSources(page) {
  await page.goto(`${BASE}/works/${WORK_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  const cards = page.locator('article[id^="source-"]');
  const count = await cards.count();

  // The recommended source is open by default, with its score preview expanded.
  await cards.first().evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await page.waitForTimeout(4000);

  // Show the grouped Download menu.
  const download = cards.first().locator('summary:has-text("Download")').first();
  if (await download.isVisible({ timeout: 1000 }).catch(() => false)) {
    await download.click();
    await page.waitForTimeout(1800);
    await download.click();
    await page.waitForTimeout(500);
  }

  // Scroll down through revisions and branches.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy({ top: 350, behavior: 'smooth' }));
    await page.waitForTimeout(1200);
  }

  // Open one other source and wait for its score preview (a fresh score engine
  // takes a few seconds to start) so the clip never rests on "Loading score".
  if (count > 1) {
    const heading = cards.nth(1).locator('h2').first();
    await heading.click();
    await page.waitForTimeout(800);
    await cards.nth(1).evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await cards.nth(1).locator('[data-testid="score-preview-frame"]').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(7000);
  }
  await page.waitForTimeout(1000);
}

// ── Scenario: Visual Musical Diff — show ONLY the embedded diff viewer for Round 1 ──
async function visualDiff(page) {
  // Load the change review page to select Round 1 and grab the iframe URL
  await page.goto(`${PROD}/change-reviews/${REVIEW_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Click Round 1
  const round1 = page.locator('button:has-text("Round 1")').first();
  if (await round1.isVisible()) {
    await round1.click();
    await page.waitForTimeout(3000);
  }

  // Extract the iframe src for the visual diff
  const iframeSrc = await page.locator('iframe[title="Score visual diff"]').getAttribute('src');
  if (!iframeSrc) {
    console.error('  Could not find visual diff iframe');
    return;
  }

  // Navigate directly to the diff viewer URL (full-page view of just the diff)
  const diffUrl = iframeSrc.startsWith('http') ? iframeSrc : `${PROD}${iframeSrc}`;
  await page.goto(diffUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(8000); // WASM load time

  // Slow scroll through the diff to show the compared scores
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy({ top: 250, behavior: 'smooth' }));
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(1500);
}

// ── Scenario: Score Editor — load score, delete bars, right sidebar tabs ──
async function scoreEditor(page) {
  const captureStartedAt = Date.now();
  const scoreUrl = encodeURIComponent(FAURE_SCORE_URL);
  await page.goto(`${BASE}/score-editor/index.html?score=${scoreUrl}`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  await page.locator('[data-testid="svg-container"] svg').waitFor({
    state: 'visible',
    timeout: 120000,
  });
  await page.waitForTimeout(750);

  const zoomMenu = page.getByTestId('zoom-preset-trigger');
  if (await zoomMenu.isVisible({ timeout: 1000 }).catch(() => false)) {
    await zoomMenu.click();
    const zoomPreset = page.getByTestId('zoom-preset-50');
    if (await zoomPreset.isVisible({ timeout: 1000 }).catch(() => false)) {
      await zoomPreset.click();
      await page.waitForTimeout(1000);
    }
  }
  const trimStart = Math.max(0, (Date.now() - captureStartedAt) / 1000 - 0.25);

  // Click on the score area to select a note — find the score rendering area
  // The score content starts below the toolbar, roughly at y=250 from viewport top
  // Click on the first visible note
  await page.mouse.click(300, 350);
  await page.waitForTimeout(500);

  // Select a few notes/beats with shift+right
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(500);

  // Delete selected content
  await page.keyboard.press('Delete');
  await page.waitForTimeout(1500);

  // Undo to restore
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(1500);

  // Open right sidebar
  const sidebarToggle = page.locator('[data-testid="btn-xml-toggle"]');
  if (await sidebarToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
    await sidebarToggle.click();
    await page.waitForTimeout(1500);

    // Switch through tabs
    for (const tabId of ['tab-harmony', 'tab-functional-harmony', 'tab-mma', 'tab-xml']) {
      const tab = page.locator(`[data-testid="${tabId}"]`);
      if (await tab.isVisible({ timeout: 500 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(1200);
      }
    }

    // Close sidebar: open → full → closed
    await sidebarToggle.click();
    await page.waitForTimeout(300);
    await sidebarToggle.click();
    await page.waitForTimeout(500);
  }

  // Navigate pages
  const nextBtn = page.locator('text=Next').first();
  if (await nextBtn.isVisible()) {
    await nextBtn.click();
    await page.waitForTimeout(1500);
    await nextBtn.click();
    await page.waitForTimeout(1500);
  }

  await page.waitForTimeout(5000);
  return { trimStart };
}

// ── Scenario: Score Player — load Fauré, start playback, show score following ──
async function scorePlayer(page) {
  const scoreUrl = encodeURIComponent(FAURE_SCORE_URL);
  await page.goto(`${BASE}/player?score=${scoreUrl}`, {
    waitUntil: 'networkidle',
    timeout: 120000,
  });

  const playerFrame = page.locator('[data-testid="standalone-player-frame"]');
  const frame = page.frameLocator('[data-testid="standalone-player-frame"]');
  await frame.getByTestId('player-svg').locator('svg').waitFor({
    state: 'visible',
    timeout: 120000,
  });

  await playerFrame.evaluate((element) => {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  await page.waitForTimeout(1500);

  const playButton = frame.getByRole('button', { name: 'Play', exact: true });
  await playButton.click();
  await frame.getByRole('button', { name: 'Pause', exact: true }).waitFor({
    state: 'visible',
    timeout: 120000,
  });
  await page.waitForTimeout(12000);
}

// ── Scenario: Catalogue (uses prod for real content) ──
async function catalogue(page) {
  await page.goto(`${PROD}/catalogue`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy({ top: 250, behavior: 'smooth' }));
    await page.waitForTimeout(1000);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(1500);
}

// ── Scenario: Scanner — public example scan (prod): pages, providers, comparison, result ──
async function scanner(page) {
  await page.goto(`${PROD}/scanner/${SCANNER_JOB_ID}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy({ top: 320, behavior: 'smooth' }));
    await page.waitForTimeout(1800);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(1500);
}

// ── Scenario: Change Review — detail → scroll to diff → round 1 → diff → round 2 → diff ──
async function changeReview(page) {
  // Navigate directly to the review detail
  await page.goto(`${PROD}/change-reviews/${REVIEW_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Helper: scroll to visual diff section and into the score content
  async function scrollToDiff() {
    await page.evaluate(() => {
      for (const s of document.querySelectorAll('section')) {
        if (s.textContent.includes('Score Visual Diff')) {
          s.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        }
      }
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
    await page.waitForTimeout(2000);
  }

  // Helper: scroll to Rounds section
  async function scrollToRounds() {
    await page.evaluate(() => {
      for (const h of document.querySelectorAll('h2')) {
        if (h.textContent.includes('Rounds')) {
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        }
      }
    });
    await page.waitForTimeout(1000);
  }

  // Show the diff for the current (latest) round
  await scrollToDiff();

  // Scroll to Changed Score Regions and open a thread comment form
  await page.evaluate(() => {
    for (const h of document.querySelectorAll('h2, h3')) {
      if (h.textContent.includes('Changed Score Regions')) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
    }
  });
  await page.waitForTimeout(1500);

  // Click "Add Thread" on the first region
  const addThread = page.locator('button:has-text("Add Thread")').first();
  if (await addThread.isVisible()) {
    await addThread.click();
    await page.waitForTimeout(2000);

    // Cancel the thread form
    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    if (await cancelBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await cancelBtn.click();
      await page.waitForTimeout(500);
    }
  }

  // Scroll up to rounds, switch to Round 1
  await scrollToRounds();
  const round1 = page.locator('button:has-text("Round 1")').first();
  if (await round1.isVisible()) {
    await round1.click();
    await page.waitForTimeout(2500);
  }

  // Scroll down to show the Round 1 diff
  await scrollToDiff();

  // Scroll up to rounds, switch to Round 2
  await scrollToRounds();
  const round2 = page.locator('button:has-text("Round 2")').first();
  if (await round2.isVisible()) {
    await round2.click();
    await page.waitForTimeout(2500);
  }

  // Show the Round 2 diff
  await scrollToDiff();
}

// ── Main ──
(async () => {
  const browser = await chromium.launch();
  const sessionCookie = await generateSessionCookie();

  const scenarios = [
    { name: 'versioned-sources', darkMode: false, interact: versionedSources, trimStart: 3, anonymous: true },
    { name: 'versioned-sources', darkMode: true, interact: versionedSources, trimStart: 3, anonymous: true },
    { name: 'visual-diff', darkMode: false, interact: visualDiff, trimStart: 15 },
    { name: 'score-editor', darkMode: false, interact: scoreEditor, trimStart: 10 },
    { name: 'player', darkMode: false, interact: scorePlayer, trimStart: 15 },
    { name: 'player', darkMode: true, interact: scorePlayer, trimStart: 15 },
    { name: 'catalogue', darkMode: false, interact: catalogue, trimStart: 3 },
    { name: 'catalogue', darkMode: true, interact: catalogue, trimStart: 3 },
    { name: 'scanner', darkMode: false, interact: scanner, trimStart: 3 },
    { name: 'scanner', darkMode: true, interact: scanner, trimStart: 3 },
    { name: 'change-review', darkMode: false, interact: changeReview, trimStart: 3 },
    { name: 'change-review', darkMode: true, interact: changeReview, trimStart: 3 },
  ];

  const requestedNames = new Set(process.argv.slice(2));
  const selectedScenarios = requestedNames.size > 0
    ? scenarios.filter((scenario) => requestedNames.has(scenario.name))
    : scenarios;
  const availableNames = new Set(scenarios.map((scenario) => scenario.name));
  const unknownNames = [...requestedNames].filter((name) => !availableNames.has(name));
  if (unknownNames.length > 0) {
    throw new Error(`Unknown feature scenario(s): ${unknownNames.join(', ')}`);
  }

  for (const scenario of selectedScenarios) {
    await recordScenario(browser, sessionCookie, scenario);
  }

  await browser.close();
  try { execSync(`rm -rf "${TMP}"`); } catch {}
  console.log('Done!');
})();
