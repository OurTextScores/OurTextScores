// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { createHmac } = require('crypto');

const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';

function b64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(sub, email, sec) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({ sub, email, iat: now, exp: now + 3600 })));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', sec).update(data).digest());
  return `${data}.${sig}`;
}

test.describe('ABC Artifact Storage and Download', () => {
  test('uploads abc file and verifies abc artifact is stored and downloadable', async ({ request }) => {
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    expect(works.length).toBeGreaterThan(0);
    const workId = works[0].workId;

    const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';
    const token = makeJwt('abc-test@local', 'abc-test@local', secret);

    const abcPath = path.join(process.cwd(), 'smoke', 'fixtures', 'simple_scale.abc');
    const originalBuffer = fs.readFileSync(abcPath);
    const originalSize = originalBuffer.length;

    const uploadResp = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources`, {
      multipart: {
        commitMessage: 'E2E test - verify abc artifact storage',
        file: {
          name: 'simple_scale.abc',
          mimeType: 'text/vnd.abc',
          buffer: originalBuffer
        }
      },
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    expect(uploadResp.ok()).toBeTruthy();
    const uploadJson = await uploadResp.json();
    const sourceId = uploadJson.sourceId;
    expect(sourceId).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    expect(detailResp.ok()).toBeTruthy();
    const detail = await detailResp.json();
    const source = detail.sources.find((s) => s.sourceId === sourceId);
    expect(source).toBeTruthy();
    expect(source.derivatives).toBeTruthy();
    expect(source.derivatives.abc).toBeTruthy();
    expect(source.derivatives.abc.contentType).toContain('text/vnd.abc');
    expect(source.derivatives.abc.sizeBytes).toBe(originalSize);
    expect(source.derivatives.canonicalXml).toBeTruthy();

    const abcDownloadUrl = `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/score.abc`;
    const abcResp = await request.get(abcDownloadUrl);
    expect(abcResp.ok()).toBeTruthy();
    expect(abcResp.headers()['content-type']).toContain('text/vnd.abc');
    expect(abcResp.headers()['content-disposition']).toContain('attachment');
    expect(abcResp.headers()['content-disposition']).toContain('.abc');

    const downloadedBuffer = await abcResp.body();
    expect(downloadedBuffer.length).toBe(originalSize);
    expect(Buffer.compare(downloadedBuffer, originalBuffer)).toBe(0);

    const canonicalResp = await request.get(
      `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml`
    );
    expect(canonicalResp.ok()).toBeTruthy();
    expect(canonicalResp.headers()['content-type']).toContain('application/xml');

    await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  });
});
