// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';

test.describe('MSCZ Artifact Storage and Download', () => {
  test('uploads mscz file and verifies mscz artifact is stored and downloadable', async ({ request }) => {
    // Get a work to upload to
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    expect(works.length).toBeGreaterThan(0);
    const workId = works[0].workId;

    // Create auth token
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
    const token = makeJwt('mscz-test@local', 'mscz-test@local', secret);

    // Read the test mscz file
    const fs = require('fs');
    const path = require('path');
    const msczPath = path.join(process.cwd(), 'test_scores', 'bach_orig.mscz');
    const originalBuffer = fs.readFileSync(msczPath);
    const originalSize = originalBuffer.length;

    // Upload the mscz file
    const uploadResp = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources`, {
      multipart: {
        commitMessage: 'E2E test - verify mscz artifact storage',
        file: {
          name: 'test_score.mscz',
          mimeType: 'application/vnd.musescore.mscz',
          buffer: originalBuffer
        }
      },
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    expect(uploadResp.ok()).toBeTruthy();
    const uploadJson = await uploadResp.json();
    const sourceId = uploadJson.sourceId;
    expect(sourceId).toBeTruthy();

    // Wait a bit for derivative processing to complete
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Fetch work detail to verify derivatives
    const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    expect(detailResp.ok()).toBeTruthy();
    const detail = await detailResp.json();
    const source = detail.sources.find(s => s.sourceId === sourceId);
    expect(source).toBeTruthy();
    expect(source.derivatives).toBeTruthy();

    // Verify mscz derivative exists
    expect(source.derivatives.mscz).toBeTruthy();
    expect(source.derivatives.mscz.contentType).toBe('application/vnd.musescore.mscz');
    expect(source.derivatives.mscz.sizeBytes).toBe(originalSize);

    // Verify other derivatives also exist (MXL, canonical, etc.)
    expect(source.derivatives.normalizedMxl).toBeTruthy();
    expect(source.derivatives.canonicalXml).toBeTruthy();

    // Download the mscz artifact
    const msczDownloadUrl = `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/score.mscz`;
    const msczResp = await request.get(msczDownloadUrl);
    expect(msczResp.ok()).toBeTruthy();

    // Verify response headers
    const headers = msczResp.headers();
    expect(headers['content-type']).toContain('application/vnd.musescore.mscz');
    expect(headers['content-disposition']).toContain('attachment');
    expect(headers['content-disposition']).toContain('.mscz');

    // Verify downloaded content matches original
    const downloadedBuffer = await msczResp.body();
    expect(downloadedBuffer.length).toBe(originalSize);
    expect(Buffer.compare(downloadedBuffer, originalBuffer)).toBe(0); // Exact match

    // Test revision-specific download
    const firstRevision = source.revisions && source.revisions[0];
    if (firstRevision && firstRevision.derivatives && firstRevision.derivatives.mscz) {
      const revMsczUrl = `${msczDownloadUrl}?r=${encodeURIComponent(firstRevision.revisionId)}`;
      const revResp = await request.get(revMsczUrl);
      expect(revResp.ok()).toBeTruthy();
      expect(revResp.headers()['cache-control']).toContain('immutable');
    }

    // Cleanup
    await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  });

  test('mxl uploads do not create mscz artifacts', async ({ request }) => {
    // Get a work to upload to
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const workId = works[0].workId;

    // Create auth token
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
    const token = makeJwt('mxl-test@local', 'mxl-test@local', secret);

    // Read a test mxl file
    const fs = require('fs');
    const path = require('path');
    const mxlPath = path.join(process.cwd(), 'test_scores', 'bach_orig.mxl');
    const mxlBuffer = fs.readFileSync(mxlPath);

    // Upload the mxl file
    const uploadResp = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources`, {
      multipart: {
        commitMessage: 'E2E test - verify MXL does not create mscz artifact',
        file: {
          name: 'test_score.mxl',
          mimeType: 'application/vnd.recordare.musicxml',
          buffer: mxlBuffer
        }
      },
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    expect(uploadResp.ok()).toBeTruthy();
    const uploadJson = await uploadResp.json();
    const sourceId = uploadJson.sourceId;

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Fetch work detail
    const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    const detail = await detailResp.json();
    const source = detail.sources.find(s => s.sourceId === sourceId);

    // Verify mscz artifact does NOT exist
    expect(source.derivatives.mscz).toBeFalsy();

    // Verify other derivatives do exist
    expect(source.derivatives.normalizedMxl).toBeTruthy();
    expect(source.derivatives.canonicalXml).toBeTruthy();

    // Verify mscz download endpoint returns 404
    const msczDownloadUrl = `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/score.mscz`;
    const msczResp = await request.get(msczDownloadUrl);
    expect(msczResp.status()).toBe(404);

    // Cleanup
    await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  });
});
