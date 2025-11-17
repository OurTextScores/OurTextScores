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

test.describe('Owned branch + approvals flow', () => {
  // This flow exercises email auth + uploads + approvals; allow more time.
  test.setTimeout(180000);
  test('create owned branch, upload to it, approve, and see filter option', async ({ page, request }) => {
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
    // After callback, go to home to see header session state
    await page.goto(BASE_URL);

    // Pick a work that has at least one source
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const work = works.find((w) => w.sourceCount && w.sourceCount > 0) || works[0];
    expect(work).toBeTruthy();

    // Record approvals count before
    await page.goto(`${BASE_URL}/approvals`);
    let inboxItems = await page.locator('main ul >> li').count();
    const hadEmpty = await page.locator('text=No pending approvals.').count();
    if (hadEmpty) inboxItems = 0;

    // Go to work detail
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(work.workId)}`);

    // Create an owned branch via API for the first source
    const workDetail = await (await request.get(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}`)).json();
    const sourceId = workDetail.sources[0].sourceId;
    const branchName = `smoke-${Date.now()}`;
    const { createHmac } = require('crypto');
    const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';
    const b64url = (buf) => buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const makeJwt = (sub, email, sec) => {
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
      const now = Math.floor(Date.now() / 1000);
      const payload = b64url(Buffer.from(JSON.stringify({ sub, email, iat: now, exp: now + 3600 })));
      const data = `${header}.${payload}`;
      const sig = b64url(createHmac('sha256', sec).update(data).digest());
      return `${data}.${sig}`;
    };
    const token = makeJwt(email, email, secret);
    const createResp = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources/${encodeURIComponent(sourceId)}/branches`, {
      data: { name: branchName, policy: 'owner_approval' },
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    expect(createResp.ok()).toBeTruthy();
    // Cleanup (delete the branch) regardless of test result
    const cleanup = async () => {
      await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources/${encodeURIComponent(sourceId)}/branches/${encodeURIComponent(branchName)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
    };
    try {

    // Upload a new revision via backend API (multipart)
    const fs = require('fs');
    const path = require('path');
    const mxlPath = path.join(process.cwd(), 'test_scores', 'bach_orig.mxl');
    const buffer = fs.readFileSync(mxlPath);
    const multipart = {
      // Fields
      commitMessage: 'smoke test revision',
      branchName
      ,
      // File
      file: {
        name: 'bach_orig.mxl',
        mimeType: 'application/vnd.recordare.musicxml',
        buffer
      }
    };
    const up = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources/${encodeURIComponent(sourceId)}/revisions`, {
      multipart,
      headers: { 'Authorization': `Bearer ${token}`, 'X-Progress-Id': `smoke-${Date.now()}` }
    });
    expect(up.ok()).toBeTruthy();
    const upJson = await up.json();
    const uploadedRevisionId = upJson.revisionId;

    // Go to approvals and expect an extra item
    await page.goto(`${BASE_URL}/approvals`);
    await expect(async () => {
      const count = await page.locator('main ul >> li').count();
      const empty = await page.locator('text=No pending approvals.').count();
      const n = empty ? 0 : count;
      expect(n).toBeGreaterThan(inboxItems);
    }).toPass({ timeout: 15000 });

    // Approve the first pending item
    const approveBtn = page.locator('button:has-text("Approve")').first();
    await approveBtn.click();
    // Wait for list count to decrease by 1 (best-effort)
    await expect(async () => {
      const count = await page.locator('main ul >> li').count();
      const empty = await page.locator('text=No pending approvals.').count();
      const n = empty ? 0 : count;
      expect(n).toBeLessThanOrEqual(Math.max(0, inboxItems));
    }).toPass({ timeout: 15000 });

    // Verify revision landed on the exact expected branch (API-level)
    const detailAuthed = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(detailAuthed.ok()).toBeTruthy();
    const detailJson = await detailAuthed.json();
    const src = detailJson.sources.find((s) => s.sourceId === sourceId);
    expect(src).toBeTruthy();
    const rev = src.revisions.find((r) => r.revisionId === uploadedRevisionId);
    expect(rev).toBeTruthy();
    expect(rev.fossilBranch).toBe(branchName);

    // Verify branches endpoints do not contain a stray branch with an extra dot
    const declared = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources/${encodeURIComponent(sourceId)}/branches`);
    expect(declared.ok()).toBeTruthy();
    const declaredJson = await declared.json();
    const declaredNames = (declaredJson.branches || []).map((b) => b.name);
    expect(declaredNames).toContain(branchName);
    expect(declaredNames).not.toContain(`${branchName}.`);

    const fossilBranches = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources/${encodeURIComponent(sourceId)}/fossil/branches`);
    if (fossilBranches.ok()) {
      const { branches: fb = [] } = await fossilBranches.json();
      // fossil/branches returns { branches: [...] }. Some repos may not list non-trunk yet; assert only if present.
      if (Array.isArray(fb) && fb.length > 0) {
        expect(fb).toContain(branchName);
        expect(fb).not.toContain(`${branchName}.`);
      }
    }

    // Back to work page and verify branch filter includes our branch
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(work.workId)}`);
    // Open all Revision history sections to ensure filter is visible
    const summaries = page.locator('summary', { hasText: 'Revision history' });
    const sCount = await summaries.count();
    for (let i = 0; i < sCount; i++) {
      await summaries.nth(i).click();
    }
    // Find branch filter dropdown
    const filters = page.locator('#branch-filter');
    const fCount = await filters.count();
    expect(fCount).toBeGreaterThan(0);
    let contained = false;
    for (let i = 0; i < fCount; i++) {
      // pass branchName into evaluate
      const opts = await filters.nth(i).evaluate((sel) => Array.from(sel.options).map(o => o.value));
      if (opts.includes(branchName)) { contained = true; break; }
    }
    expect(contained).toBeTruthy();
    } finally {
      await cleanup();
    }
  });
});
