// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';
test.describe('Owned branch + approvals flow', () => {
  // This flow exercises email auth + uploads + approvals; allow more time.
  test.setTimeout(180000);
  test('create owned branch, upload to it, approve, and see filter option', async ({ page, request }) => {
    const email = process.env.SMOKE_EMAIL || 'smoke@example.test';

    // Pick a work that has at least one source
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const work = works.find((w) => w.sourceCount && w.sourceCount > 0) || works[0];
    expect(work).toBeTruthy();

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
      try {
        await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources/${encodeURIComponent(sourceId)}/branches/${encodeURIComponent(branchName)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } catch {
        // best-effort cleanup; ignore if context is closed
      }
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

    // Approve the pending revision directly via API for reliability
    const approveResp = await request.post(
      `${PUBLIC_API}/works/${encodeURIComponent(work.workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(uploadedRevisionId)}/approve`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    expect(approveResp.ok()).toBeTruthy();

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
    const sourceLabel = src.label || sourceId;

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

    // Back to work page and verify branch filter includes our branch (auto-open the source card)
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(work.workId)}?source=${encodeURIComponent(sourceId)}`);
    const card = page.locator('article', { hasText: sourceLabel }).first();
    await expect(card).toBeVisible({ timeout: 20000 });
    const filter = card.locator('#branch-filter').first();
    await expect(filter).toBeVisible({ timeout: 20000 });
    const opts = await filter.evaluate((sel) => Array.from(sel.options).map(o => o.value));
    expect(opts).toContain(branchName);
    } finally {
      await cleanup();
    }
  });
});
