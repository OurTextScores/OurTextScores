// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';

test.describe('SSE progress sanity', () => {
  test('receives progress events during upload and completes', async ({ page, request }) => {
    // Pick a work
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const workId = works[0].workId;

    const progressId = `smoke-${Date.now()}`;
    const sseUrl = `${PUBLIC_API}/works/progress/${encodeURIComponent(progressId)}/stream`;

    // Start SSE listener in the browser context
    const ssePromise = page.evaluate((url) => {
      return new Promise((resolve) => {
        const events = [];
        const es = new EventSource(url);
        const finish = () => { try { es.close(); } catch {} resolve(events); };
        const timer = setTimeout(finish, 20000); // cap
        es.addEventListener('progress', (ev) => {
          try {
            const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
            events.push({ event: 'progress', data });
            if (events.length >= 2) {
              clearTimeout(timer);
              // Leave the stream open briefly to allow potential 'done', then close
              setTimeout(finish, 1000);
            }
          } catch { /* ignore */ }
        });
        es.addEventListener('done', () => {
          clearTimeout(timer);
          finish();
        });
        es.addEventListener('error', () => {
          // best-effort finish on error
          clearTimeout(timer);
          finish();
        });
      });
    }, sseUrl);

    // Kick off upload with the same progress id
    const fs = require('fs');
    const path = require('path');
    const mxlPath = path.join(process.cwd(), 'test_scores', 'bach_orig.mxl');
    const buffer = fs.readFileSync(mxlPath);

    const multipart = {
      commitMessage: 'sse sanity',
      file: { name: 'bach_orig.mxl', mimeType: 'application/vnd.recordare.musicxml', buffer }
    };
    const up = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources`, {
      multipart,
      headers: { 'X-Progress-Id': progressId }
    });
    expect(up.ok()).toBeTruthy();
    const upJson = await up.json();
    const createdSourceId = upJson.sourceId;

    const events = await ssePromise;
    expect(Array.isArray(events)).toBeTruthy();
    expect(events.length).toBeGreaterThan(0);
    // at least one event should have a stage
    const stages = events.map((e) => e?.data?.stage).filter(Boolean);
    expect(stages.length).toBeGreaterThan(0);

    // Cleanup: delete the created source (requires auth header, but backend will upsert user)
    const { createHmac } = require('crypto');
    const secret = process.env.AUTH_SECRET || 'dev-secret';
    const b64url = (buf) => buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const makeJwt = (sub, email, sec) => {
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
      const now = Math.floor(Date.now() / 1000);
      const payload = b64url(Buffer.from(JSON.stringify({ sub, email, iat: now, exp: now + 3600 })));
      const data = `${header}.${payload}`;
      const sig = b64url(createHmac('sha256', sec).update(data).digest());
      return `${data}.${sig}`;
    };
    const token = makeJwt('smoke@local', 'smoke@local', secret);
    await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(createdSourceId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  });
});
