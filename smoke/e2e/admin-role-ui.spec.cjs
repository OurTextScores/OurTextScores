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

test.describe('Admin-related UI affordances', () => {
  test('source owner can delete via work page UI', async ({ page, request }) => {
    const email = process.env.SMOKE_EMAIL || 'smoke@example.test';

    // Sign in via Email magic link
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
    await page.goto(BASE_URL);

    // Pick a work
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const work = works[0];
    expect(work).toBeTruthy();
    const workId = work.workId;

    // Create JWT for the same email so backend resolves the same user document
    const { createHmac } = require('crypto');
    const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';
    const b64url = (buf) => buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const makeJwt = (sub, mail, sec) => {
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
      const now = Math.floor(Date.now() / 1000);
      const payload = b64url(Buffer.from(JSON.stringify({ sub, email: mail, iat: now, exp: now + 3600 })));
      const data = `${header}.${payload}`;
      const sig = b64url(createHmac('sha256', sec).update(data).digest());
      return `${data}.${sig}`;
    };
    const token = makeJwt(email, email, secret);

    // Upload a new source as this user via API
    const fs = require('fs');
    const path = require('path');
    const mxlPath = path.join(process.cwd(), 'test_scores', 'bach_orig.mxl');
    const buffer = fs.readFileSync(mxlPath);
    const label = `Admin Delete Test Source ${Date.now()}`;
    const multipart = {
      label,
      commitMessage: 'admin delete ui test',
      file: { name: 'bach_orig.mxl', mimeType: 'application/vnd.recordare.musicxml', buffer }
    };
    const up = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources`, {
      multipart,
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(up.ok()).toBeTruthy();
    const upJson = await up.json();
    const sourceId = upJson.sourceId;
    expect(sourceId).toBeTruthy();

    // Open work detail page
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(workId)}`);

    // Non-admin users should not see the Admin tools panel
    await expect(page.locator('section:has-text("Admin tools")')).toHaveCount(0);

    // Find the source card for the uploaded source and delete it via UI
    const card = page.locator('article', { hasText: label }).first();
    await expect(card).toBeVisible({ timeout: 20000 });

    const deleteButton = card.locator('button:has-text("Delete source")').first();
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    // Wait for the card to disappear after revalidation
    await expect(page.locator('article', { hasText: label })).toHaveCount(0, { timeout: 20000 });

    // Verify via API that the source is gone
    const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    expect(detailResp.ok()).toBeTruthy();
    const detail = await detailResp.json();
    const stillThere = (detail.sources || []).some((s) => s.sourceId === sourceId);
    expect(stillThere).toBeFalsy();
  });
});
