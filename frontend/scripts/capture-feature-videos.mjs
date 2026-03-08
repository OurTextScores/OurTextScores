#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { encode } from 'next-auth/jwt';

const BASE = 'http://localhost:3000';
const PROD = 'https://ourtextscores.com';
const OUT = resolve(import.meta.dirname, '../public/images/features');
const TMP = resolve(import.meta.dirname, '../.video-tmp');
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

const WORK_ID = '1148359'; // Coleridge-Taylor Piano Trio — 4 visually distinct sources
const REVIEW_ID = 'b81896dd-0ce1-4b60-b5e4-29273c7384aa';
const SCORE_SOURCE_ID = '6d54848c-2da6-49e4-ac40-de769eadca1e';
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
  const cmd = `ffmpeg -y ${ssArg} -i "${srcPath}" -vf "scale=${width}:-2" -an -c:v libvpx -b:v 600k -crf 25 "${destPath}"`;
  execSync(cmd, { stdio: 'pipe' });
}

async function recordScenario(browser, sessionCookie, { name, darkMode, interact, trimStart = 0 }) {
  const suffix = darkMode ? 'dark' : 'light';
  const videoDir = resolve(TMP, `${name}-${suffix}`);
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  await context.addCookies([sessionCookie]);
  if (darkMode) {
    await context.addInitScript(() => { localStorage.setItem('theme', 'dark'); });
  } else {
    await context.addInitScript(() => { localStorage.setItem('theme', 'light'); });
  }

  const page = await context.newPage();
  try {
    await interact(page);
  } catch (err) {
    console.error(`  ERROR in ${name}-${suffix}:`, err.message);
  }

  await page.close();
  const rawVideoPath = await page.video().path();
  await context.close();

  const outPath = `${OUT}/${name}-${suffix}.webm`;
  processVideo(rawVideoPath, outPath, { trimStart });
  console.log(`  captured ${name}-${suffix}.webm`);

  try { unlinkSync(rawVideoPath); } catch {}
}

// ── Scenario: Versioned Sources — expand sources, show content ──
async function versionedSources(page) {
  await page.goto(`${BASE}/works/${WORK_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Scroll past the IMSLP metadata section to the sources
  await page.evaluate(() => {
    const articles = document.querySelectorAll('article[id^="source-"]');
    if (articles.length > 0) articles[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  await page.waitForTimeout(1000);

  const cards = page.locator('article[id^="source-"]');
  const count = await cards.count();

  for (let i = 0; i < Math.min(count, 3); i++) {
    // Expand source card by clicking the h2 (contains the arrow + label)
    const heading = cards.nth(i).locator('h2').first();
    await heading.click();
    await page.waitForTimeout(1000);

    // Scroll to show expanded content
    await cards.nth(i).evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await page.waitForTimeout(2000);

    // Collapse before expanding the next
    if (i < Math.min(count, 3) - 1) {
      await heading.click();
      await page.waitForTimeout(500);
    }
  }
  await page.waitForTimeout(1000);
}

// ── Scenario: Visual Musical Diff — show ONLY the embedded diff viewer for Round 1 ──
async function visualDiff(page) {
  // Load the change review page to select Round 1 and grab the iframe URL
  await page.goto(`${BASE}/change-reviews/${REVIEW_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
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
  const diffUrl = iframeSrc.startsWith('http') ? iframeSrc : `${BASE}${iframeSrc}`;
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
  const scoreUrl = encodeURIComponent(
    `${BASE}/api/works/${WORK_ID}/sources/${SCORE_SOURCE_ID}/canonical.xml`
  );
  await page.goto(`${BASE}/score-editor/index.html?score=${scoreUrl}`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  await page.waitForTimeout(8000); // WASM load time

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

// ── Scenario: Projects (uses prod for real content) ──
async function projects(page) {
  await page.goto(`${PROD}/projects`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
    await page.waitForTimeout(1200);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(1500);
}

// ── Scenario: Change Review — detail → scroll to diff → round 1 → diff → round 2 → diff ──
async function changeReview(page) {
  // Navigate directly to the review detail
  await page.goto(`${BASE}/change-reviews/${REVIEW_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
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
    { name: 'versioned-sources', darkMode: false, interact: versionedSources, trimStart: 3 },
    { name: 'versioned-sources', darkMode: true, interact: versionedSources, trimStart: 3 },
    { name: 'visual-diff', darkMode: false, interact: visualDiff, trimStart: 15 },
    { name: 'score-editor', darkMode: false, interact: scoreEditor, trimStart: 10 },
    { name: 'catalogue', darkMode: false, interact: catalogue, trimStart: 3 },
    { name: 'catalogue', darkMode: true, interact: catalogue, trimStart: 3 },
    { name: 'projects', darkMode: false, interact: projects, trimStart: 3 },
    { name: 'projects', darkMode: true, interact: projects, trimStart: 3 },
    { name: 'change-review', darkMode: false, interact: changeReview, trimStart: 3 },
    { name: 'change-review', darkMode: true, interact: changeReview, trimStart: 3 },
  ];

  for (const scenario of scenarios) {
    await recordScenario(browser, sessionCookie, scenario);
  }

  await browser.close();
  try { execSync(`rm -rf "${TMP}"`); } catch {}
  console.log('Done!');
})();
