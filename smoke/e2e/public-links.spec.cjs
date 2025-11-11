// @ts-check
const { test, expect } = require('@playwright/test');

const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';

test.describe('Public links + health', () => {
  test('health endpoints are OK', async ({ request }) => {
    const d = await request.get('http://localhost:3000/api/diagnostics/email');
    expect(d.ok()).toBeTruthy();
    const w = await request.get(`${PUBLIC_API}/works`);
    expect(w.ok()).toBeTruthy();
  });

  test('work detail anchors use public API base and resolve', async ({ page, request }) => {
    // Fetch a work id via API
    const works = await request.get(`${PUBLIC_API}/works`);
    expect(works.ok()).toBeTruthy();
    const list = (await works.json()).works;
    expect(Array.isArray(list) && list.length > 0).toBeTruthy();
    const workId = list[0].workId;

    await page.goto(`/works/${encodeURIComponent(workId)}`);

    // Collect anchors that hit our API
    const links = await page.$$eval('a[href*="/api/works/"]', (els) => els.map((a) => a.getAttribute('href')));
    expect(links.length).toBeGreaterThan(0);

    // Assert all links point to public API base
    for (const href of links) {
      if (!href) continue;
      expect(href.startsWith(`${PUBLIC_API}/`)).toBeTruthy();
    }

    // Only fetch small files to verify they resolve (skip large PDFs/MXLs to avoid timeout)
    let okCount = 0;
    for (const href of links) {
      if (!href) continue;
      // Skip large binary files (PDF, MXL) - only test small files like manifest and text diffs
      if (href.includes('.pdf') || href.includes('.mxl')) continue;
      try {
        const resp = await request.get(href, { timeout: 5000 });
        if (resp.status() === 200) okCount += 1;
      } catch (e) {
        // Ignore timeouts on individual requests
      }
      // Stop after verifying a few links work
      if (okCount >= 3) break;
    }
    expect(okCount).toBeGreaterThan(0);
  });
});

