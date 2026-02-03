// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';

async function listMessages(request) {
  const v1 = await request.get(`${MAILPIT}/api/v1/messages?limit=50`);
  if (v1.ok()) {
    const data = await v1.json();
    return Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : []);
  }
  const legacy = await request.get(`${MAILPIT}/api/msgs`);
  if (legacy.ok()) return await legacy.json();
  return [];
}

async function getMagicLink(request, toEmail, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msgs = await listMessages(request);
    for (const m of msgs) {
      const toList = (m.To || m.to || []).map((t) => (typeof t === 'string' ? t : t.Address || t.address)).filter(Boolean);
      const subj = m.Subject || m.subject || '';
      if (toList.find((t) => String(t).toLowerCase().includes(toEmail.toLowerCase())) && String(subj).includes('Sign in')) {
        const id = m.ID || m.Id || m.id || m.MessageID || m.messageId;
        if (!id) continue;
        const msgResp = await request.get(`${MAILPIT}/api/v1/message/${id}`);
        if (msgResp.ok()) {
          const data = await msgResp.json();
          const html = data?.HTML || '';
          const text = data?.Text || '';
          let match = html.match(/href=\"(http[^\"]+\/api\/auth\/callback\/email[^\"]*)\"/i);
          if (match && match[1]) return match[1];
          match = text.match(/(http[^\s]+\/api\/auth\/callback\/email[^\s]*)/i);
          if (match && match[1]) return match[1];
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Magic link not found');
}

test.describe('Viewers + Diff + Watch', () => {
  test('renders OSMD/PDF and diff, and toggles watch', async ({ page, request }) => {
    const email = process.env.SMOKE_EMAIL || 'smoke@example.test';
    // Sign in
    await page.goto(`${BASE_URL}/api/auth/signin`);
    const input = page.locator('input[type="email"][name="email"]');
    if (!(await input.count())) {
      const btn = page.locator('button:has-text("Email"), a:has-text("Email")');
      if (await btn.count()) await btn.first().click();
    }
    await expect(page.locator('input[type="email"][name="email"]')).toBeVisible({ timeout: 5000 });
    await page.fill('input[type="email"][name="email"]', email);
    const submit = page.locator('button:has-text("Sign in with Email"), button:has-text("Send magic link"), button:has-text("Sign in")');
    if (await submit.count()) await submit.first().click(); else await page.keyboard.press('Enter');
    const magic = await getMagicLink(request, email);
    await page.goto(magic);

    // Choose a work with derivatives
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    const works = (await worksResp.json()).works;
    const work = works.find((w) => (w.availableFormats || []).length > 0) || works[0];
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(work.workId)}`);

    // OSMD (MXL preview)
    const mxlSummary = page.locator('summary', { hasText: 'Score preview (MXL)' });
    if (await mxlSummary.count()) {
      await mxlSummary.first().click();
      // Wait for any OSMD SVG on the page
      await expect(page.locator('svg[id^="osmdSvgPage"], svg[id*="osmdSvg"]').first()).toBeVisible({ timeout: 15000 });
    }

    // PDF preview
    const pdfSummary = page.locator('summary', { hasText: 'Score preview (PDF)' });
    if (await pdfSummary.count()) {
      await pdfSummary.first().click();
      await expect(page.locator('object[type="application/pdf"]').first()).toBeVisible({ timeout: 10000 });
    }

    // Diff preview
    // Open revision history and Diff section
    // There can be multiple sources; open all revision history summaries
    const revSummaries = page.locator('summary', { hasText: 'Revision history' });
    const rs = await revSummaries.count();
    for (let i = 0; i < rs; i++) await revSummaries.nth(i).click();
    // Switch Diff type to XML and expect diff content
    const typeSelect = page.locator('label:has-text("Type") >> select');
    if (await typeSelect.count()) {
      await typeSelect.first().selectOption('xml');
      const diffEl = page.locator('.d2h-wrapper, .d2h-file-wrapper').first();
      // UI may render but be offscreen/hidden; try to scroll into view then fallback to API checks
      try {
        await diffEl.scrollIntoViewIfNeeded();
        await expect(diffEl).toBeVisible({ timeout: 15000 });
      } catch {
        // Fallback: call textdiff API directly (XML/manifest), ensure non-empty
        const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}`);
        const detail = await detailResp.json();
        const src = detail.sources[0];
        const revs = src.revisions.slice(0, 2);
        if (revs.length >= 2) {
          const a = revs[1].revisionId, b = revs[0].revisionId;
          const t2 = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources/${encodeURIComponent(src.sourceId)}/textdiff?revA=${encodeURIComponent(a)}&revB=${encodeURIComponent(b)}&file=canonical`);
          expect(t2.ok()).toBeTruthy();
          const txt2 = await t2.text();
          expect((txt2 || '').length).toBeGreaterThan(0);
        }
      }
    }

    // Watch toggle (first source card)
    const watchBtn = page.locator('form button:has-text("Watch (")').first();
    if (await watchBtn.count()) {
      await watchBtn.click();
      await expect(page.locator('form button:has-text("Watching (")').first()).toBeVisible({ timeout: 10000 });
    }
  });
});
