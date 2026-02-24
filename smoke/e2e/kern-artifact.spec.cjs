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

test.describe('KRN Artifact Storage and Download', () => {
  test('uploads krn file and verifies krn artifact is stored and downloadable', async ({ request }) => {
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    expect(works.length).toBeGreaterThan(0);
    const workId = works[0].workId;

    const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';
    const token = makeJwt('krn-test@local', 'krn-test@local', secret);

    const krnPath = path.join(process.cwd(), 'smoke', 'fixtures', 'kernscores_533_1.krn');
    const originalBuffer = fs.readFileSync(krnPath);
    const originalSize = originalBuffer.length;

    const uploadResp = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources`, {
      multipart: {
        commitMessage: 'E2E test - verify krn artifact storage',
        file: {
          name: 'kernscores_533_1.krn',
          mimeType: 'application/x-kern',
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

    // Raw KRN retention should work regardless of converter availability.
    expect(source.derivatives.krn).toBeTruthy();
    expect(source.derivatives.krn.contentType).toBe('application/x-kern');
    expect(source.derivatives.krn.sizeBytes).toBe(originalSize);

    const krnDownloadUrl = `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/score.krn`;
    const krnResp = await request.get(krnDownloadUrl);
    expect(krnResp.ok()).toBeTruthy();
    expect(krnResp.headers()['content-type']).toContain('application/x-kern');
    expect(krnResp.headers()['content-disposition']).toContain('attachment');
    expect(krnResp.headers()['content-disposition']).toContain('.krn');

    const downloadedBuffer = await krnResp.body();
    expect(downloadedBuffer.length).toBe(originalSize);
    expect(Buffer.compare(downloadedBuffer, originalBuffer)).toBe(0);

    // Docker smoke stack config now ships a default Kern converter.
    expect(source.derivatives.canonicalXml).toBeTruthy();
    const canonicalResp = await request.get(
      `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml`
    );
    expect(canonicalResp.ok()).toBeTruthy();
    expect(canonicalResp.headers()['content-type']).toContain('application/xml');

    // MXL may still be pending if MuseScore cannot re-export the converted XML for some reason,
    // but when present it should be downloadable.
    if (source.derivatives.normalizedMxl) {
      const mxlResp = await request.get(
        `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/normalized.mxl`
      );
      expect(mxlResp.ok()).toBeTruthy();
      expect(mxlResp.headers()['content-type']).toContain('application/vnd.recordare.musicxml');
    }

    const firstRevisionWithManifest = Array.isArray(source.revisions)
      ? source.revisions.find((r) => r && r.manifest)
      : null;
    if (firstRevisionWithManifest && firstRevisionWithManifest.manifest) {
      const manifestResp = await request.get(
        `${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/manifest.json?r=${encodeURIComponent(firstRevisionWithManifest.revisionId)}`
      );
      expect(manifestResp.ok()).toBeTruthy();
      const manifest = await manifestResp.json();
      const hasKrnArtifact = Array.isArray(manifest.artifacts) &&
        manifest.artifacts.some((a) => a.type === 'krn');
      expect(hasKrnArtifact).toBeTruthy();
    }

    const firstRevision = source.revisions && source.revisions[0];
    if (firstRevision && firstRevision.derivatives && firstRevision.derivatives.krn) {
      const revKrnUrl = `${krnDownloadUrl}?r=${encodeURIComponent(firstRevision.revisionId)}`;
      const revResp = await request.get(revKrnUrl);
      expect(revResp.ok()).toBeTruthy();
      expect(revResp.headers()['cache-control']).toContain('immutable');
    }

    await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  });
});
