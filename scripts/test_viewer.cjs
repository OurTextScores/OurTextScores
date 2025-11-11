#!/usr/bin/env node
// Headless check that OSMD viewer paginates with custom small page size
const puppeteer = require('puppeteer');

async function run() {
  const url = process.argv[2] || 'http://localhost:3000/works/164349';
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.on('console', async msg => {
    try {
      const args = await Promise.all(msg.args().map(a => a.jsonValue().catch(() => null)));
      console.log('[browser]', msg.type().toUpperCase(), msg.text(), JSON.stringify(args));
    } catch (e) {
      console.log('[browser]', msg.type().toUpperCase(), msg.text());
    }
  });
  page.on('pageerror', err => {
    console.log('[browser]', 'PAGEERROR', err?.message || String(err));
  });
  page.setDefaultTimeout(30000);
  page.on('response', async res => {
    try {
      if (res.status() >= 400) {
        console.log('[browser] RESPONSE', res.status(), res.url());
      }
    } catch {}
  });
  console.log(`[viewer-test] Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Expand the first Score preview details (if collapsed)
  const summaries = await page.$$eval('summary', nodes => nodes.map(n => (n.textContent || '').trim()));
  console.log('[viewer-test] Found summaries:', summaries);
  const index = summaries.findIndex(t => /Score preview/i.test(t));
  if (index >= 0) {
    const handles = await page.$$('summary');
    const handle = handles[index];
    await handle.click();
  } else {
    console.log('[viewer-test] Could not find Score preview summary; aborting.');
    await browser.close();
    process.exit(2);
  }

  // Allow render to complete
  await new Promise(r => setTimeout(r, 3000));

  // Count pages
  const pageCount = await page.evaluate(() => document.querySelectorAll('.osmd-page, [id^="osmdCanvasPage"]').length || 0);
  const containerCount = await page.evaluate(() => document.querySelectorAll('.opensheetmusicdisplay-container').length || 0);
  const svgCount = await page.evaluate(() => document.querySelectorAll('.opensheetmusicdisplay-container svg').length || 0);
  // Check white background on the container
  const bgIsWhite = await page.evaluate(() => {
    const container = document.querySelector('div.bg-white');
    if (!container) return false;
    const style = window.getComputedStyle(container);
    const bg = style.backgroundColor.toLowerCase();
    return bg === 'rgb(255, 255, 255)' || bg === '#ffffff' || bg.includes('255, 255, 255');
  });
  const dbg = await page.evaluate(() => {
    const c = document.querySelector('div.bg-white');
    return c ? { html: c.innerHTML.slice(0, 2000), length: c.innerHTML.length } : { html: null, length: 0 };
  });
  console.log(JSON.stringify({ pageCount, containerCount, svgCount, bgIsWhite, containerHtmlLen: dbg.length }));
  console.log('[viewer-test] container snippet:', dbg.html);

  await browser.close();
}

run().catch(err => {
  console.error('[viewer-test] Error:', err?.message || String(err));
  process.exit(1);
});
